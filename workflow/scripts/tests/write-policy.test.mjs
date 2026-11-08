// 文件：write-policy.test.mjs
// 描述：写仓闸分类/受信/模式单源（内部决策-066 D4/D5，内部任务-261）纯函数行为测试——C1-C6 分类正负例、
//       C1 仓内目标作用域（tmp 负例/`>|`）、受信命令精确匹配与「受信＋重定向/换行」拒绝、
//       逐类模式解析（C5 恒 shadow、classes.C5 拒绝并 warning）、decideWriteIntent 与坏
//       scriptWrites 降级。零 spawn。
// 作者：wangp  创建：2026-10-31  版权：MIT（见 workflow/LICENSE）
// 纪律：仅 node: 内置模块；纯函数表驱动。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CLASSES, classifyShellWrite, isTrustedCommand, resolveMode, decideWriteIntent } from '../lib/write-policy.mjs';

const ROOT = process.cwd();
const t = (p) => isTrustedCommand(p, { root: ROOT }).trusted;
const cls = (cmd) => classifyShellWrite(cmd, { root: ROOT }).cls;

test('DEV-261 受信写者清单单源：精确路径+子命令匹配，前缀/通配/重定向/换行不授信', () => {
  assert.equal(t('node workflow/scripts/mechanical-edit.mjs --spec x.json --state-dir s'), true);
  assert.equal(t('node workflow/scripts/evidence-gen.mjs --files a --out o --state-dir s --write'), true);
  assert.equal(t('node plugin-core/cli.mjs materialize'), true);
  assert.equal(t('node plugin-core/cli.mjs verify'), true);
  assert.equal(t('node zcode-adapter/cli.mjs bump --version 1.0.0'), true);
  assert.equal(t('node spec-gate/core/validator/validate_specs.mjs --mode draft'), true);
  assert.equal(t('node scripts/check-repo-consistency.mjs'), true);
  assert.equal(t('node --test "workflow/scripts/tests/*.test.mjs"'), true);
  // 负例：前缀/通配/未知子命令/未知脚本/重定向/换行
  assert.equal(t('node workflow/scripts/mechanical-edit.mjs.bak --x'), false);
  assert.equal(t('node workflow/scripts/*.mjs --x'), false);
  assert.equal(t('node plugin-core/cli.mjs materialize-evil'), false);
  assert.equal(t('node evil.mjs materialize'), false);
  assert.equal(t('node scripts/check-repo-consistency.mjs > workflow/hooks/evil.mjs'), false);
  assert.equal(t('node scripts/check-repo-consistency.mjs >> docs/x.md'), false);
  assert.equal(t('node scripts/check-repo-consistency.mjs\nnode hooks/evil.mjs'), false);
  assert.deepEqual(CLASSES, ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']);
});

test('C1 重定向写文件：仓内目标命中；tmp/特殊设备/引号内/fd dup 负例；`>|` 命中', () => {
  assert.equal(cls('echo hi > a.txt'), 'C1');
  assert.deepEqual(classifyShellWrite('echo hi >> docs/out.md', { root: ROOT }).targets, ['docs/out.md']);
  assert.equal(cls('cat <<EOF > a.txt\nhi\nEOF'), 'C1');
  assert.equal(cls('echo hi >| a.txt'), 'C1', '`>|` 覆写重定向须命中');
  assert.equal(cls('echo hi > /dev/null'), null);
  assert.equal(cls('echo hi > /dev/shm/x'), null);
  assert.equal(cls('echo hi 2>&1'), null);
  assert.equal(cls('grep "a > b" a.txt'), null);
  assert.equal(cls("grep 'x >> y' a.md"), null);
  // 内部决策-066 D4/D10：仓外目标不是 C1（tmp 负例）
  assert.equal(cls(`echo hi > ${join(tmpdir(), 'dev261-outside.txt')}`), null);
  assert.equal(cls('echo hi > /tmp/x.log'), null);
});

test('C2 就地编辑：sed -i / perl -pi / awk -i inplace 命中；只读用法负例', () => {
  assert.equal(cls("sed -i 's/a/b/' a.txt"), 'C2');
  assert.equal(cls("perl -pi -e 's/a/b/' a.txt"), 'C2');
  assert.equal(cls("awk -i inplace '{print}' a.txt"), 'C2');
  assert.equal(cls('sed -n "1,5p" a.txt'), null);
  assert.equal(cls('perl -n -e "print" a.txt'), null);
});

test('C3 解释器内联写 API：node -e/python -c/pwsh -Command 含写 API 命中；只读内联负例', () => {
  assert.equal(cls("node -e \"require('fs').writeFileSync('a','x')\""), 'C3');
  assert.equal(cls('python3 -c "open(\'a\',\'w\').write(\'x\')"'), 'C3');
  assert.equal(cls("pwsh -Command \"Set-Content a.txt x\""), 'C3');
  assert.equal(cls('node -e "console.log(1)"'), null);
  assert.equal(cls('python3 -c "print(1)"'), null);
});

test('C4 heredoc 喂解释器含写 API 命中（含 node - <<）；纯文本 heredoc 负例', () => {
  assert.equal(cls("node <<'EOF'\nrequire('fs').writeFileSync('a','x')\nEOF"), 'C4');
  assert.equal(cls("node - <<'EOF'\nrequire('fs').writeFileSync('a','x')\nEOF"), 'C4');
  assert.equal(cls("cat <<'EOF'\nhello\nEOF"), null);
});

test('OPEN-279（DEV-308）：解释器与 << 之间夹选项仍识别 C4；只读命令仍 skip', () => {
  const body = "require('fs').writeFileSync('a','x')";
  assert.equal(cls(`node --input-type=module <<'EOF'\n${body}\nEOF`), 'C4', 'flag 夹在解释器与 heredoc 之间不得判 null');
  assert.equal(cls(`node --require ./x.cjs <<'EOF'\n${body}\nEOF`), 'C4', '带值选项（--require ./x.cjs）同样识别');
  assert.equal(cls(`node -e "${body}"`), 'C3', '既有内联形态不受影响');
  assert.equal(cls(`node --input-type=module <<'EOF'\nconsole.log('x')\nEOF`), null, '无写 API 的只读 heredoc 仍不归闸');
  // 命令位锚定：引号内字面量提及「node … <<EOF」不得误判（收紧后负例）
  assert.equal(cls(`git commit -m "docs: node --x <<EOF writeFileSync"`), null, '非命令位的字样不判 C4');
  // 只读命令对照：跳过分级（cls null→skip）语义不变
  assert.equal(cls('ls -la'), null);
  assert.equal(cls('npm test'), null);
});

test('C5 文件操作分类仅标记（cp/mv/rm/tee/find -exec）；C6 VCS 操作单独分类', () => {
  for (const cmd of ['cp a b', 'mv a b', 'rm a.txt', 'tee a.txt', 'touch a.txt', 'ln -s a b', 'echo x | tee a.txt']) {
    assert.equal(cls(cmd), 'C5', cmd);
  }
  assert.equal(cls('find . -name "*.tmp" -exec rm {} \\;'), 'C5');
  for (const cmd of ['git apply p.patch', 'git restore a.txt', 'git checkout -- a.txt', 'git clean -fd']) {
    assert.equal(cls(cmd), 'C6', cmd);
  }
  assert.equal(cls('ls -la'), null);
});

test('C2/C3/C4 目标作用域：仓外(tmp)负例；相对路径按 cwd 解析（子目录不误判）', () => {
  const sub = join(ROOT, 'workflow');
  assert.equal(classifyShellWrite("sed -i 's/a/b/' /tmp/dev261-x.txt", { root: ROOT }).cls, null, 'C2 仓外目标不归闸');
  assert.equal(classifyShellWrite("node -e \"require('fs').writeFileSync('/tmp/dev261-x.txt','x')\"", { root: ROOT }).cls, null, 'C3 仓外目标不归闸');
  assert.equal(classifyShellWrite("node <<'EOF'\nrequire('fs').writeFileSync('/tmp/dev261-x.txt','x')\nEOF", { root: ROOT }).cls, null, 'C4 仓外目标不归闸');
  // 仓内相对路径仍命中（C3/C2）
  assert.equal(classifyShellWrite("node -e \"require('fs').writeFileSync('a.txt','x')\"", { root: ROOT }).cls, 'C3');
  assert.equal(classifyShellWrite("sed -i 's/a/b/' docs/x.md", { root: ROOT }).cls, 'C2');
  // cwd 子目录：../内部计划 实际落在仓内 → C1；../../outside.md 仓外 → null
  assert.equal(classifyShellWrite('echo hi > ../docs/plans/z.md', { root: ROOT, cwd: sub }).cls, 'C1', 'cwd 相对路径须解析到仓内');
  assert.equal(classifyShellWrite('echo hi > ../../dev261-outside.md', { root: ROOT, cwd: sub }).cls, null, 'cwd 相对路径解析到仓外不归闸');
  // 混写：仓外绝对路径 + 引号内仓内相对路径（带扩展名）仍须归类（N1）
  assert.equal(classifyShellWrite("node -e \"require('fs').writeFileSync('/tmp/dev261-x','x');require('fs').writeFileSync('docs/y.md','y')\"", { root: ROOT }).cls, 'C3', '混写含仓内相对路径须归类');
  // Windows 盘符绝对路径（posix 上视为仓外，D10 不约束）
  assert.equal(classifyShellWrite("node -e \"require('fs').writeFileSync('C:\\\\Temp\\\\dev261-x.txt','x')\"", { root: ROOT }).cls, null, 'win32 盘符路径视为仓外');
  // N4：引号内“仅扩展名、无目录段”的字面量（如 MIME/'package.json' 文案）不得当仓内路径
  assert.equal(classifyShellWrite("node -e \"require('fs').writeFileSync('/tmp/dev261-fp.json','package.json')\"", { root: ROOT }).cls, null, '仓外写＋引号内无目录段字面量不得误判 C3');
});

test('模式解析：默认 C1-C4 enforce/C5 恒 shadow/C6 null；env 与配置覆盖；classes 只作用 C1-C4', () => {
  const base = resolveMode({});
  assert.equal(base.modes.C1, 'enforce');
  assert.equal(base.modes.C4, 'enforce');
  assert.equal(base.modes.C5, 'shadow');
  assert.equal(base.modes.C6, null);
  const envShadow = resolveMode({ envMode: 'shadow' });
  assert.equal(envShadow.modes.C1, 'shadow');
  assert.equal(envShadow.modes.C5, 'shadow');
  const cfg = resolveMode({ configRaw: JSON.stringify({ mode: 'enforce', classes: { C2: 'shadow' } }) });
  assert.equal(cfg.modes.C1, 'enforce');
  assert.equal(cfg.modes.C2, 'shadow');
  assert.equal(cfg.modes.C5, 'shadow', 'C5 恒 shadow');
  const c5Override = resolveMode({ configRaw: JSON.stringify({ classes: { C5: 'enforce' } }) });
  assert.equal(c5Override.modes.C5, 'shadow', 'classes.C5 必须忽略');
  assert.match(String(c5Override.warning), /C5/);
  const bad = resolveMode({ configRaw: '{bad json' });
  assert.equal(bad.modes.C1, 'enforce', '非法配置回落默认');
  assert.ok(bad.warning, '非法配置须告警');
});

test('decideWriteIntent：enforce 无声明 deny；shadow record；声明/受信 allow；C5 record；坏声明降级', () => {
  const mode = resolveMode({});
  assert.equal(decideWriteIntent({ cmd: 'echo x > a.txt', root: ROOT, mode }).decision, 'deny');
  const shadow = resolveMode({ envMode: 'shadow' });
  assert.equal(decideWriteIntent({ cmd: 'echo x > a.txt', root: ROOT, mode: shadow }).decision, 'record');
  assert.equal(decideWriteIntent({ cmd: 'echo x > a.txt', root: ROOT, mode, scriptWrites: [{ reason: 'x'.repeat(8), declaredAt: 't' }] }).reason, 'declared');
  assert.equal(decideWriteIntent({ cmd: 'node workflow/scripts/mechanical-edit.mjs --selftest', root: ROOT, mode }).decision, 'allow');
  assert.equal(decideWriteIntent({ cmd: 'cp a b', root: ROOT, mode }).decision, 'record', 'C5 恒 record');
  assert.equal(decideWriteIntent({ cmd: 'git restore a.txt', root: ROOT, mode }).decision, 'skip');
  assert.equal(decideWriteIntent({ cmd: 'ls -la', root: ROOT, mode }).decision, 'skip');
  // 受信脚本＋重定向：必须按 C1 走模式（enforce→deny，而非 trusted allow）
  assert.equal(decideWriteIntent({ cmd: 'node scripts/check-repo-consistency.mjs > x.md', root: ROOT, mode }).decision, 'deny');
  // 仓外重定向：非 C1；受信 shell 无写意图 → trusted allow / 非受信为 skip
  assert.equal(decideWriteIntent({ cmd: 'echo x > /tmp/dev261-y.log', root: ROOT, mode }).decision, 'skip');
  const badDecl = decideWriteIntent({ cmd: 'echo x > a.txt', root: ROOT, mode, scriptWrites: 'not-array' });
  assert.equal(badDecl.decision, 'deny');
  assert.equal(badDecl.declared, false);
  assert.equal(badDecl.degraded, true, '坏 scriptWrites 须标记 degraded');
});

test('redirect 引号目标与未知模式兜底分支', () => {
  assert.equal(classifyShellWrite('echo hi > "docs/quoted.md"', { root: ROOT }).cls, 'C1', '双引号目标须识别');
  assert.equal(classifyShellWrite("echo hi > 'docs/quoted2.md'", { root: ROOT }).cls, 'C1', '单引号目标须识别');
  assert.equal(classifyShellWrite('echo hi >| docs/quoted3.md', { root: ROOT }).cls, 'C1', '>| 覆写须识别');
  assert.equal(classifyShellWrite('echo hi 2>&1 > /tmp/dev261-quoted-out.log', { root: ROOT }).cls, null, 'fd dup 不误判');
  const unknown = decideWriteIntent({ cmd: 'echo x > a.txt', root: ROOT, mode: { modes: { C1: 'bogus' } } });
  assert.equal(unknown.decision, 'record');
  assert.equal(unknown.degraded, true, '未知模式须 record+degraded（不静默放行）');
});

// ── 内部任务-285：受检路径（git 跟踪）分级与窄声明矩阵（纯函数，isTracked 注入） ─────────────
test('DEV-285 目标解析扩展：C2 操作数、C3/C4 文本候选、C1 重定向目标', async () => {
  const { inPlaceTargets, scriptContentCandidates } = await import('../lib/write-policy.mjs');
  assert.deepEqual(inPlaceTargets("sed -i 's/a/b/' a.txt b.md").sort(), ['a.txt', 'b.md']);
  assert.deepEqual(inPlaceTargets("perl -pi -e 's/x/y/g' services/x.go").sort(), ['services/x.go']);
  assert.deepEqual(inPlaceTargets('sed -n 1p a.txt'), [], '非就地编辑不产目标');
  // code-review r1：引号内的 | ; 是 sed/perl 表达式分隔符，不得当 shell 段分隔（否则受检窄声明被绕过）
  assert.deepEqual(inPlaceTargets("sed -i 's|a|b|' src/x.js").sort(), ['src/x.js'], '引号内 | 不得当分隔符');
  assert.deepEqual(inPlaceTargets("sed -i 's/a/b/;s/c/d/' src/x.js").sort(), ['src/x.js'], '引号内 ; 不得切段');
  assert.deepEqual(inPlaceTargets("perl -pi -e 's/a/b/g; s/c/d/g' src/x.js").sort(), ['src/x.js'], 'perl 多语句同款');
  const content = "python3 - <<'EOF'\nfrom pathlib import Path\nPath('deploy/x.yaml').write_text('a')\nEOF";
  assert.ok(scriptContentCandidates(content).includes('deploy/x.yaml'), 'C4 文本候选须抽取引号路径');
  const c2 = classifyShellWrite("sed -i 's/a/b/' a.txt", { root: ROOT });
  assert.equal(c2.cls, 'C2');
  assert.deepEqual(c2.targets, ['a.txt'], 'C2 须带出目标（受检判定依赖）');
});

// ── 内部任务-339（内部未决-254②）：C2 命中与目标抽取 token 单源（引号感知，IN_PLACE_RES 整条正则退役） ──
test('DEV-339 OPEN-254②：C2 token 单源——选项置换/引号清理/-f 实参/{print}/s{}{} 五正例与 sed -n/--quiet/引号内字面量三负例', async () => {
  const { inPlaceTargets } = await import('../lib/write-policy.mjs');
  // 五正例：全部应判 C2（现行：①②③判 null＝漏拦，④⑤目标误含非文件 token）
  assert.equal(cls("sed 's|a|b|' -i f"), 'C2', 'GNU 选项置换（-i 后置）');
  assert.equal(cls('sed -i "s/\\"//g" f'), 'C2', '双引号清理写法');
  assert.equal(cls("sed -i \"s/'//g\" f"), 'C2', '单引号清理写法');
  assert.equal(cls('sed -i -f script.sed f'), 'C2', '-f 脚本实参形态');
  assert.equal(cls('perl -i -pe s{a}{b} f'), 'C2', 'perl 花括号表达式');
  // 三负例：不得判 C2
  assert.equal(cls('sed -n "1,5p" f'), null, 'sed -n 非就地');
  assert.equal(cls("sed --quiet 's/a/b/' f"), null, '--quiet 不含 i 语义');
  assert.equal(cls('echo "sed -i s/a/b/ f"'), null, '引号内字面量提及非命令位');
  // 目标抽取断言（内部未决-254②目标侧）
  assert.deepEqual(inPlaceTargets('sed -i -f script.sed f').sort(), ['f'], '-f 实参不算目标');
  assert.deepEqual(inPlaceTargets("awk -i inplace '{print}' f").sort(), ['f'], 'awk 程序块不算目标');
  assert.deepEqual(inPlaceTargets('perl -i -pe s{a}{b} f').sort(), ['f'], 'perl 表达式不算目标');
  assert.deepEqual(inPlaceTargets("sed -i 's/a/b/' f tracked.md").sort(), ['f', 'tracked.md'], '常规目标保持');
});

// ── 内部任务-339（内部未决-254①⑥）：混合形态重定向受检目标逐目标恒拒＋只读内联负例锁定 ──
test('DEV-339 OPEN-254①⑥：混合形态 redirects 逐目标受检恒拒与只读内联负例', () => {
  // ① 混合形态：cls 仍为 C2，但 redirects 含 tracked.txt；受检 tracked.txt 恒拒（窄声明也不放行）
  const mixed = classifyShellWrite("sed -i 'x' f > tracked.txt", { root: ROOT });
  assert.equal(mixed.cls, 'C2');
  assert.deepEqual(mixed.redirects, ['tracked.txt'], '分类输出须带 redirects 字段');
  const both = () => 'tracked';
  const sw = [{ reason: '本轮批量机械替换执行', declaredAt: new Date().toISOString() }];
  const se = [{ reason: '本轮脚本编辑受检文件', declaredAt: new Date().toISOString() }];
  const d = decideWriteIntent({ cmd: "sed -i 'x' f > tracked.txt", root: ROOT, mode: resolveMode({}), scriptWrites: sw, scriptEditCode: se, isTracked: both });
  assert.equal(d.decision, 'deny');
  assert.equal(d.reason, 'tracked-redirect-rejected', '重定向受检目标恒拒，窄声明不放行');
  // 纯 C2 混合形态中的就地目标仍可窄声明（不丢通道）：重定向目标非受检时
  const onlyF = (p) => (p === 'f' ? 'tracked' : 'untracked');
  const d2 = decideWriteIntent({ cmd: "sed -i 'x' f > untracked.txt", root: ROOT, mode: resolveMode({}), scriptEditCode: se, isTracked: onlyF });
  assert.equal(d2.decision, 'allow');
  assert.equal(d2.reason, 'declared-edit-code');
  // ⑥ 只读内联负例锁定（规范引号形态不误判 C1）
  for (const c of [
    'node --input-type=module -e "const n = Object.keys(process.env).filter(k => k > 1).length; console.log(n)"',
    'node --input-type=module -e "if (Number(process.env.N || 0) > 0) { console.log(1) }"',
    'node -e "console.log(process.env.HOME.length > 1)"',
  ]) assert.equal(cls(c), null, `只读内联不得误判：${c}`);
});

// ── 内部任务-339 S1 阶段复审 #1/#2 回归锁 ─────────────────────────────────────────────
test('DEV-339 stage 复审：引号包裹的被执行载荷与路径前缀工具形态不丢 C2；echo 数据性引号实参保持放行', () => {
  // 旧整条正则按字面命中的「被执行」形态——token 化不得丢失（拦→不拦禁令）
  assert.equal(cls("sh -c 'sed -i s/a/b/ f'"), 'C2', 'sh -c 引号载荷内的就地编辑');
  assert.equal(cls('bash -c "sed -i \'s/a/b/\' f"'), 'C2', 'bash -c 双层引号形态');
  assert.equal(cls("node -e \"require('child_process').execSync('sed -i s/a/b/ f')\""), 'C2', '解释器载荷内 execSync sed');
  assert.equal(cls('bin/sed -i s/a/b/ f'), 'C2', '路径前缀工具形态（\\btool\\b 旧按字面命中）');
  assert.equal(cls('sed.exe -i s/a/b/ f'), 'C2', 'win32 可执行后缀形态');
  // 数据性引号实参（非执行载荷）保持放行——字面量提及放行面不回退
  assert.equal(cls('echo "sed -i s/a/b/ f"'), null, 'echo 数据性引号实参保持 null');
  // r1 三维（简洁#1/#2）回归锁：按工具分表的带值 flag——sed `-E` 不带值（目标不得被吞）；
  // 载荷正则须与 INLINE_INTERP_RE 同源保留 /i（PowerShell 参数不区分大小写）
  const eFlag = classifyShellWrite("sed -i 's/a/b/' -E tracked.md", { root: ROOT });
  assert.equal(eFlag.cls, 'C2', 'sed -E 是无值选项，不吞后续目标');
  assert.deepEqual(eFlag.targets, ['tracked.md'], '唯一受检目标不得被并集带值表吞掉');
  assert.equal(cls("powershell -command \"sed -i 's/a/b/' f\""), 'C2', '小写 -command 经 /i 进入载荷递归');
  // r2 N2/N3：perl `-0`（裸写不消费下一 token）不吞目标；工具名带路径前缀时按归一名查表
  const p0 = classifyShellWrite("perl -pi -e 's/a/b/' -0 tracked.md", { root: ROOT });
  assert.deepEqual(p0.targets, ['tracked.md'], 'perl -0 裸写不吞后续目标');
  const pfx = classifyShellWrite('bin/sed -i -f script.sed tracked.md', { root: ROOT });
  assert.deepEqual(pfx.targets, ['tracked.md'], '路径前缀工具按归一名查分表（-f 实参不算目标）');
  // r3 D4/②：awk 装饰形态与 -i 粘连/长形态
  assert.equal(cls("awk.exe -i inplace '{print}' f"), 'C2', 'awk.exe 后缀形态走 awk 判支');
  assert.equal(cls("awk -iinplace '{print}' f"), 'C2', 'gawk -i 粘连写法（--include）');
  assert.equal(cls("awk --include=inplace '{print}' f"), 'C2', 'gawk --include= 长形态');
});

test('DEV-339 stage 复审：shadow 违例旗＝enforce 会拦（窄声明足额的受检 C2 不是违例）', () => {
  const tracked = () => 'tracked';
  const se = [{ reason: '本轮脚本编辑受检文件', declaredAt: new Date().toISOString() }];
  // shadow＋窄声明足额：enforce 档会放行（declared-edit-code）⇒ 非违例、wouldBeDeny=false
  const ok = decideWriteIntent({ cmd: "sed -i 's/a/b/' tracked.txt", root: ROOT, mode: resolveMode({ envTrackedTier: 'shadow' }), scriptEditCode: se, isTracked: tracked });
  assert.equal(ok.decision, 'record');
  assert.equal(ok.trackedTierViolation, false, '窄声明足额的受检 C2 在 enforce 下放行——非违例');
  // shadow＋混合形态重定向受检目标：窄声明在 enforce 也不放行 ⇒ 违例保持 true
  const bad = decideWriteIntent({ cmd: "sed -i 'x' tracked.txt > tracked2.txt", root: ROOT, mode: resolveMode({ envTrackedTier: 'shadow' }), scriptEditCode: se, isTracked: tracked });
  assert.equal(bad.trackedTierViolation, true, '重定向受检目标 enforce 恒拒 ⇒ 违例');
});

test('DEV-285 tracked tier 裁决矩阵：C1 拒绝、C2–C4 仅窄声明、untracked 不变、unknown degraded、shadow 只记录', () => {
  const tracked = () => 'tracked';
  const untracked = () => 'untracked';
  const unknown = () => 'unknown';
  const sw = [{ reason: '本轮批量机械替换执行', declaredAt: new Date().toISOString() }];
  const se = [{ reason: '本轮脚本编辑受检文件', declaredAt: new Date().toISOString() }];
  // C1 受检：即便有 scriptWrites 也直接拒绝
  const c1 = decideWriteIntent({ cmd: 'echo x > a.txt', root: ROOT, mode: resolveMode({}), isTracked: tracked, scriptWrites: sw });
  assert.equal(c1.decision, 'deny');
  assert.equal(c1.reason, 'tracked-redirect-rejected');
  assert.equal(c1.tier, 'tracked');
  assert.deepEqual(c1.trackedTargets, ['a.txt']);
  // C2 受检：通用 scriptWrites 不足；窄声明放行
  const c2Generic = decideWriteIntent({ cmd: "sed -i 's/a/b/' a.txt", root: ROOT, mode: resolveMode({}), isTracked: tracked, scriptWrites: sw });
  assert.equal(c2Generic.reason, 'tracked-needs-script-edit-code');
  const c2Narrow = decideWriteIntent({ cmd: "sed -i 's/a/b/' a.txt", root: ROOT, mode: resolveMode({}), isTracked: tracked, scriptEditCode: se });
  assert.equal(c2Narrow.decision, 'allow');
  assert.equal(c2Narrow.reason, 'declared-edit-code');
  // C4 受检：同样只认窄声明
  const c4 = "python3 - <<'EOF'\nfrom pathlib import Path\nPath('a.txt').write_text('x')\nEOF";
  assert.equal(decideWriteIntent({ cmd: c4, root: ROOT, mode: resolveMode({}), isTracked: tracked, scriptWrites: sw }).reason, 'tracked-needs-script-edit-code');
  assert.equal(decideWriteIntent({ cmd: c4, root: ROOT, mode: resolveMode({}), isTracked: tracked, scriptEditCode: se }).decision, 'allow');
  // 非受检：现行为不变（generic 声明放行）
  assert.equal(decideWriteIntent({ cmd: "sed -i 's/a/b/' a.txt", root: ROOT, mode: resolveMode({}), isTracked: untracked, scriptWrites: sw }).decision, 'allow');
  // 混合目标：任一受检从严（code-review r1）
  const trackedByName = (p) => (p.startsWith('tracked') ? 'tracked' : 'untracked');
  const mixed = decideWriteIntent({ cmd: "sed -i 's/a/b/' tracked.txt untracked.txt", root: ROOT, mode: resolveMode({}), isTracked: trackedByName, scriptWrites: sw });
  assert.equal(mixed.reason, 'tracked-needs-script-edit-code', '混合目标任一受检须从严（窄声明）');
  assert.deepEqual(mixed.trackedTargets, ['tracked.txt']);
  // unknown：不冒充受检 + trackedDegraded
  const unk = decideWriteIntent({ cmd: 'echo x > a.txt', root: ROOT, mode: resolveMode({}), isTracked: unknown });
  assert.equal(unk.trackedDegraded, true);
  assert.equal(unk.tier, null);
  // shadow：只记录且 trackedTierViolation 可见
  const shadow = decideWriteIntent({ cmd: 'echo x > a.txt', root: ROOT, mode: resolveMode({ envTrackedTier: 'shadow' }), isTracked: tracked });
  assert.equal(shadow.decision, 'record');
  assert.equal(shadow.trackedTierViolation, true);
  // 模式解析：默认 enforce；配置文件 shadow；非法回落+告警
  assert.equal(resolveMode({}).trackedTier, 'enforce');
  assert.equal(resolveMode({ configRaw: '{"trackedTier":"shadow"}' }).trackedTier, 'shadow');
  const bad = resolveMode({ configRaw: '{"trackedTier":"bogus"}' });
  assert.equal(bad.trackedTier, 'enforce');
  assert.ok(String(bad.warning).includes('trackedTier'));
});

test('DEV-341 受信写者含项目 skill 清单生成器 --apply', () => {
  const trusted = (cmd) => isTrustedCommand(cmd, { root: ROOT }).trusted;
  assert.equal(trusted('node workflow/scripts/generate-project-skills-manifest.mjs --apply'), true);
  assert.equal(trusted('node workflow/scripts/generate-project-skills-manifest.mjs --check'), false);
  assert.equal(trusted('node elsewhere/generate-project-skills-manifest.mjs --apply'), false);
});
