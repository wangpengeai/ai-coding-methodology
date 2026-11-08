// 文件：os-observe-sysmon.test.mjs
// 描述：win-sysmon 扩展位启用链行为测试（内部任务-SYSMON-1，内部验收-12）——guide 四要素、
//       prepare 未核验不落账（fetch 失败/签名 Invalid/解压失败三拒）、enable 提权链
//       （三件部署/RunAs 命令形态/退出码透传/复核链）、disable 幂等、status provenance
//       对拍。全部经注入缝（fetchFn/spawnFn/platform），fixture 用临时目录。
// 作者：wangp  创建：2026-09-19  版权：MIT（见 team-governance/LICENSE）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'; // 内部任务-337：mkdtempSync 随 tmpHome 收口移除（零残余消费）
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  sysmonGuide, sysmonPrepare, sysmonEnable, sysmonDisable, sysmonStatus, SYSMON_TASK_NAME,
} from '../adapters/os-observe-sysmon.mjs';
import { tmpHome } from './helpers.mjs';

// 内部任务-337（内部未决-223）：tmpHome 收口至 tests/helpers.mjs。

/** 在 fixture home 下伪造已解压的 Sysmon64.exe（status 对拍用；先建目录）。 */
function fakeExe(home, bytes) {
  const dir = join(home, 'sysmon');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'Sysmon64.exe');
  writeFileSync(p, bytes);
  return p;
}

test('sysmonGuide：四要素齐备且步骤覆盖启用全链（NFR-tg-supplychain）', () => {
  const g = sysmonGuide();
  assert.equal(g.ok, true);
  assert.ok(g.elements.source.includes('download.sysinternals.com'));
  assert.ok(g.elements.verification.includes('签名'));
  assert.ok(g.elements.policy.includes('不启用'));
  assert.ok(g.elements.version.length > 0);
  assert.ok(g.steps.length >= 6);
  assert.ok(g.steps.join('\n').includes('sysmon-enable'));
});

test('sysmonPrepare：非 win32 unavailable（不提供未实测命令）', async () => {
  const r = await sysmonPrepare({ platform: 'linux' });
  assert.equal(r.ok, false);
  assert.equal(r.availability, 'unavailable');
});

test('sysmonPrepare：下载非 200 拒且不写 provenance（未核验不启用）', async () => {
  const home = tmpHome('os-observe-sysmon-');
  const prev = process.env.OS_OBSERVE_HOME;
  try {
    process.env.OS_OBSERVE_HOME = home;
    const r = await sysmonPrepare({ fetchFn: async () => ({ ok: false, status: 404 }), platform: 'win32' });
    assert.equal(r.ok, false);
    assert.ok(String(r.error).includes('404'));
    assert.equal(existsSync(join(home, 'sysmon', 'provenance.json')), false);
  } finally {
    process.env.OS_OBSERVE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('sysmonPrepare：签名 Invalid 拒且不写 provenance；Valid+Microsoft 落四要素账', async () => {
  const home = tmpHome('os-observe-sysmon-');
  const prev = process.env.OS_OBSERVE_HOME;
  const verifyJson = (status, subject) => JSON.stringify({ status, subject, version: '15.15', sha256: 'AB'.repeat(32) });
  const makeSpawn = (sigJson) => (cmd, args) => {
    if (cmd === 'powershell.exe' && String(args[2]).includes('Expand-Archive')) {
      // 桩不真解压：伪造解压产物 Sysmon64.exe（fixture 语义=解压成功）
      fakeExe(home, Buffer.from('stub-exe'));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'powershell.exe') return { status: 0, stdout: sigJson, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  try {
    process.env.OS_OBSERVE_HOME = home;
    const fetchFn = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
    // Invalid：拒且不落账
    let r = await sysmonPrepare({ fetchFn, spawnFn: makeSpawn(verifyJson('NotSigned', 'CN=Evil')), platform: 'win32' });
    assert.equal(r.ok, false);
    assert.ok(String(r.error).includes('签名核验未过'), `拒因须为签名核验（收到 ${r.error}）`);
    assert.equal(existsSync(join(home, 'sysmon', 'provenance.json')), false);
    // Valid + Microsoft：落 provenance 四要素（sha256 小写归一）
    r = await sysmonPrepare({ fetchFn, spawnFn: makeSpawn(verifyJson('Valid', 'CN=Microsoft Windows Publishing')), platform: 'win32' });
    assert.equal(r.ok, true, `Valid 应通过（收到 ${JSON.stringify(r)}）`);
    const prov = JSON.parse(readFileSync(join(home, 'sysmon', 'provenance.json'), 'utf8'));
    assert.equal(prov.schemaVersion, 1);
    assert.equal(prov.version, '15.15');
    assert.equal(prov.sha256Sysmon64, 'ab'.repeat(32));
    assert.ok(prov.signatureSubject.includes('Microsoft'));
    assert.equal(provenanceHasUrl(prov), true);
  } finally {
    process.env.OS_OBSERVE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
  function provenanceHasUrl(p) { return typeof p.sourceUrl === 'string' && p.sourceUrl.startsWith('https://'); }
});

test('sysmonPrepare：解压失败拒（Expand-Archive 非零）', async () => {
  const home = tmpHome('os-observe-sysmon-');
  const prev = process.env.OS_OBSERVE_HOME;
  try {
    process.env.OS_OBSERVE_HOME = home;
    const r = await sysmonPrepare({
      fetchFn: async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer }),
      spawnFn: (cmd, args) => (cmd === 'powershell.exe' && String(args[2]).includes('Expand-Archive') ? { status: 2, stdout: '', stderr: 'corrupt' } : { status: 0, stdout: '', stderr: '' }),
      platform: 'win32',
    });
    assert.equal(r.ok, false);
    assert.ok(String(r.error).includes('解压失败'));
    assert.equal(existsSync(join(home, 'sysmon', 'provenance.json')), false);
  } finally {
    process.env.OS_OBSERVE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('sysmonEnable：部署三件到 bin、提权命令含 RunAs 与脚本路径、复核链全零', async () => {
  const home = tmpHome('os-observe-sysmon-');
  const prev = process.env.OS_OBSERVE_HOME;
  const calls = [];
  try {
    process.env.OS_OBSERVE_HOME = home;
    mkdirSync(join(home, 'bin'), { recursive: true });
    writeFileSync(join(home, 'bin', 'collect.vbs'), "' stub"); // 守卫前置条件：启动包装在场（内部任务-OSOBWIN-1）
    const fetchFn = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer });
    const spawnFn = (cmd, args, opts) => {
      calls.push([cmd, args, opts]);
      if (cmd === 'powershell.exe' && String(args[2]).includes('Expand-Archive')) { fakeExe(home, Buffer.from('stub-exe')); return { status: 0, stdout: '', stderr: '' }; }
      if (cmd === 'powershell.exe' && String(args[2]).includes('RunAs')) {
        // 模拟提权脚本成功：写结果文件（真实通道=轮询 elevated-result.txt，不依赖 Start-Process 退出码）
        mkdirSync(join(home, 'sysmon'), { recursive: true });
        writeFileSync(join(home, 'sysmon', 'elevated-result.txt'), '0');
        return { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'powershell.exe') {
        return { status: 0, stdout: JSON.stringify({ status: 'Valid', subject: 'CN=Microsoft Windows Publishing', version: '15.15', sha256: 'ab'.repeat(32) }), stderr: '' };
      }
      if (cmd === 'sc') return { status: 0, stdout: 'STATE              :  4  RUNNING', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const r = await sysmonEnable({ fetchFn, spawnFn, platform: 'win32' });
    assert.equal(r.ok, true, `启用应成功（收到 ${JSON.stringify(r)}）`);
    assert.equal(r.task, SYSMON_TASK_NAME);
    for (const f of ['collect-sysmon.ps1', 'sysmon-config.xml', 'sysmon-install-elevated.ps1']) {
      assert.ok(existsSync(join(home, 'bin', f)), `bin 缺 ${f}`);
    }
    const elevated = calls.find(([c, a]) => c === 'powershell.exe' && String(a[2]).includes('RunAs'));
    assert.ok(elevated, '提权命令须含 -Verb RunAs');
    assert.ok(String(elevated[1][2]).includes('$env:TG_ELEV_PS1'), '提权命令经 env 取脚本路径（N-3 参数化）');
    assert.equal(elevated[2]?.env?.TG_ELEV_PS1, join(home, 'bin', 'sysmon-install-elevated.ps1'), 'env 携带已部署脚本真实路径');
    assert.ok(calls.some(([c, a]) => c === 'sc' && a.includes('Sysmon64')), '须复核服务态');
    assert.ok(calls.some(([c, a]) => c === 'schtasks' && a.includes(SYSMON_TASK_NAME)), '须复核任务在册');
    const create = calls.find(([c, a]) => c === 'schtasks' && a.includes('/Create'));
    assert.ok(create, '须注册采集任务');
    const tr2 = create[1][create[1].indexOf('/TR') + 1];
    assert.ok(tr2.startsWith('wscript.exe //nologo "'), '任务动作=GUI 宿主包装（防闪窗）');
    assert.ok(tr2.includes(join(home, 'bin', 'collect.vbs')), '包装路径在部署面');
    assert.ok(tr2.endsWith(' collect-sysmon.ps1'), '尾部裸参=sysmon 采集器（引号存活由步骤 7 探针核验）');
  } finally {
    process.env.OS_OBSERVE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('sysmonEnable：提权退出码透传（UAC 取消/安装失败可见）', async () => {
  const home = tmpHome('os-observe-sysmon-');
  const prev = process.env.OS_OBSERVE_HOME;
  try {
    process.env.OS_OBSERVE_HOME = home;
    mkdirSync(join(home, 'bin'), { recursive: true });
    writeFileSync(join(home, 'bin', 'collect.vbs'), "' stub"); // 守卫前置条件：启动包装在场（内部任务-OSOBWIN-1）
    const fetchFn = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer });
    const spawnFn = (cmd, args) => {
      if (cmd === 'powershell.exe' && String(args[2]).includes('Expand-Archive')) { fakeExe(home, Buffer.from('stub-exe')); return { status: 0, stdout: '', stderr: '' }; }
      if (cmd === 'powershell.exe' && String(args[2]).includes('RunAs')) {
        // 模拟提权脚本失败：结果文件写 5
        mkdirSync(join(home, 'sysmon'), { recursive: true });
        writeFileSync(join(home, 'sysmon', 'elevated-result.txt'), '5');
        return { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'powershell.exe') {
        return { status: 0, stdout: JSON.stringify({ status: 'Valid', subject: 'CN=Microsoft Windows Publishing', version: '15.15', sha256: 'ab'.repeat(32) }), stderr: '' };
      }
      if (cmd === 'sc') return { status: 0, stdout: 'STATE              :  4  RUNNING', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const r = await sysmonEnable({ fetchFn, spawnFn, platform: 'win32' });
    assert.equal(r.ok, false);
    assert.ok(String(r.error).includes('5'), `错误须含退出码（收到 ${r.error}）`);
  } finally {
    process.env.OS_OBSERVE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('sysmonDisable：移除采集任务幂等（schtasks 退 1=不存在按已移除）且引导驱动卸载', () => {
  const run = (status) => sysmonDisable({
    spawnFn: () => ({ status, stdout: '', stderr: '' }),
    platform: 'win32',
  });
  const gone = run(1);
  assert.equal(gone.ok, true);
  assert.ok(gone.note.includes('不存在') || gone.note.includes('幂等'));
  const removed = run(0);
  assert.equal(removed.ok, true);
  assert.ok(removed.note.includes('Sysmon64.exe -u'), '驱动卸载属用户决策面，输出引导而非自动执行');
});

test('sysmonStatus：provenance 对拍两态（本地二进制哈希 vs 记账）', async () => {
  const home = tmpHome('os-observe-sysmon-');
  const prev = process.env.OS_OBSERVE_HOME;
  try {
    process.env.OS_OBSERVE_HOME = home;
    // 无 provenance：provenance=null、provenanceMatch=false（不伪造）
    let s = sysmonStatus({ spawnFn: (cmd) => (cmd === 'sc' ? { status: 0, stdout: 'STATE              :  4  RUNNING', stderr: '' } : { status: 0, stdout: '', stderr: '' }), platform: 'win32' });
    assert.equal(s.provenance, null);
    assert.equal(s.provenanceMatch, false);
    // 有 provenance 且本地二进制一致 → true（哈希以 Node 侧实算为准）
    const bytes = Buffer.from('sysmon-binary-bytes');
    fakeExe(home, bytes);
    const sha256 = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
    const dir = join(home, 'sysmon');
    writeFileSync(join(dir, 'provenance.json'), `${JSON.stringify({ schemaVersion: 1, sourceUrl: 'https://download.sysinternals.com/files/Sysmon.zip', version: '15.15', sha256Sysmon64: sha256, signatureSubject: 'CN=Microsoft Windows Publishing', verifiedAt: '2026-09-19T00:00:00Z' })}\n`);
    s = sysmonStatus({ spawnFn: (cmd) => (cmd === 'sc' ? { status: 0, stdout: 'STATE              :  4  RUNNING', stderr: '' } : { status: 0, stdout: '', stderr: '' }), platform: 'win32' });
    assert.equal(s.provenanceMatch, true);
    // 本地二进制被篡改 → false
    fakeExe(home, Buffer.from('tampered'));
    s = sysmonStatus({ spawnFn: (cmd) => (cmd === 'sc' ? { status: 0, stdout: 'STATE              :  4  RUNNING', stderr: '' } : { status: 0, stdout: '', stderr: '' }), platform: 'win32' });
    assert.equal(s.provenanceMatch, false);
  } finally {
    process.env.OS_OBSERVE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('sysmonEnable：非提权任务注册失败可见（schtasks /Create 非零）', async () => {
  const home = tmpHome('os-observe-sysmon-');
  const prev = process.env.OS_OBSERVE_HOME;
  try {
    process.env.OS_OBSERVE_HOME = home;
    mkdirSync(join(home, 'bin'), { recursive: true });
    writeFileSync(join(home, 'bin', 'collect.vbs'), "' stub"); // 守卫前置条件：启动包装在场（内部任务-OSOBWIN-1）
    const fetchFn = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer });
    const spawnFn = (cmd, args) => {
      if (cmd === 'powershell.exe' && String(args[2]).includes('Expand-Archive')) { fakeExe(home, Buffer.from('stub-exe')); return { status: 0, stdout: '', stderr: '' }; }
      if (cmd === 'powershell.exe' && String(args[2]).includes('RunAs')) {
        mkdirSync(join(home, 'sysmon'), { recursive: true });
        writeFileSync(join(home, 'sysmon', 'elevated-result.txt'), '0');
        return { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'powershell.exe') return { status: 0, stdout: JSON.stringify({ status: 'Valid', subject: 'CN=Microsoft Windows Publishing', version: '15.15', sha256: 'ab'.repeat(32) }), stderr: '' };
      if (cmd === 'schtasks' && args.includes('/Create')) return { status: 1, stdout: '', stderr: '拒绝访问' };
      if (cmd === 'sc') return { status: 0, stdout: 'RUNNING', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const r = await sysmonEnable({ fetchFn, spawnFn, platform: 'win32', pollIntervalMs: 1 });
    assert.equal(r.ok, false);
    assert.ok(String(r.error).includes('采集任务注册失败'), `拒因须为任务注册（收到 ${r.error}）`);
  } finally {
    process.env.OS_OBSERVE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('sysmonEnable：旧结果文件先清除+超时口径（轮询注入缝，垃圾内容归超时）', async () => {
  const home = tmpHome('os-observe-sysmon-');
  const prev = process.env.OS_OBSERVE_HOME;
  try {
    process.env.OS_OBSERVE_HOME = home;
    // 预置陈旧结果文件（若未清除会被读成 99 → 断言失败；正确行为=清除后超时）
    mkdirSync(join(home, 'sysmon'), { recursive: true });
    writeFileSync(join(home, 'sysmon', 'elevated-result.txt'), '99');
    mkdirSync(join(home, 'bin'), { recursive: true });
    writeFileSync(join(home, 'bin', 'collect.vbs'), "' stub"); // 守卫前置条件：启动包装在场（内部任务-OSOBWIN-1）
    const fetchFn = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer });
    const spawnFn = (cmd, args) => {
      if (cmd === 'powershell.exe' && String(args[2]).includes('Expand-Archive')) { fakeExe(home, Buffer.from('stub-exe')); return { status: 0, stdout: '', stderr: '' }; }
      if (cmd === 'powershell.exe' && String(args[2]).includes('RunAs')) {
        // 模拟提权脚本只写垃圾（写一半截断形态）——归超时口径而非 NaN
        writeFileSync(join(home, 'sysmon', 'elevated-result.txt'), '');
        return { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'powershell.exe') return { status: 0, stdout: JSON.stringify({ status: 'Valid', subject: 'CN=Microsoft Windows Publishing', version: '15.15', sha256: 'ab'.repeat(32) }), stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const r = await sysmonEnable({ fetchFn, spawnFn, platform: 'win32', pollIntervalMs: 1, resultTimeoutMs: 30 });
    assert.equal(r.ok, false);
    assert.ok(String(r.error).includes('提权结果超时'), `陈旧/垃圾结果须归超时（收到 ${r.error}）`);
    assert.ok(!String(r.error).includes('99'), '陈旧结果文件须被清除而非误读');
    assert.ok(!String(r.error).includes('NaN'), '垃圾内容不得产出 NaN 退出码文案');
  } finally {
    process.env.OS_OBSERVE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('sysmonEnable：collect.vbs 缺场显式报错指回 install（写面失败可见，零副作用）', async () => {
  const home = tmpHome('os-observe-sysmon-');
  const prev = process.env.OS_OBSERVE_HOME;
  const calls = [];
  try {
    process.env.OS_OBSERVE_HOME = home;
    const r = await sysmonEnable({
      fetchFn: async () => { throw new Error('prepare 不应被调用'); },
      spawnFn: (cmd, args) => { calls.push([cmd, args]); return { status: 0, stdout: '', stderr: '' }; },
      platform: 'win32',
    });
    assert.equal(r.ok, false);
    assert.equal(r.needInstall, true);
    assert.ok(r.error.includes('collect.vbs'));
    assert.equal(calls.length, 0); // 守卫在 prepare/下载/提权之前，零副作用
  } finally {
    process.env.OS_OBSERVE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

// 内部任务-DEBTFIX-1：采样器须拒收「提供程序宿主」归因事件（采集器自观测伪影）。
// 行为面依赖 PowerShell + Sysmon 日志，仓库侧不可自动化——本断言的职责是挡住
// 「拒收子句被误删」；行为证据在计划步骤 4 的真机同一命令前后对拍。
test('collect-sysmon.ps1 拒收宿主归因且先于落样本（内部任务-DEBTFIX-1）', () => {
  const src = readFileSync(fileURLToPath(new URL('../adapters/os-observe/collect-sysmon.ps1', import.meta.url)), 'utf8');
  assert.ok(src.includes("$HOST_ATTRIBUTION_HOSTS = @('wmiprvse.exe')"), '宿主名单常量缺场（字面量锁定，删掉即红）');
  assert.ok(src.includes('$HOST_ATTRIBUTION_HOSTS -contains $procName'), '拒收子句缺场');
  assert.ok(
    src.indexOf('$HOST_ATTRIBUTION_HOSTS -contains $procName') < src.indexOf('$lines.Add(('),
    '拒收必须发生在落样本之前',
  );
  // 水位语义守卫（内部任务-SYSMON-REPLAY-1 改写：旧锚 $lastTs 已随缺陷修复删除）
  const clauseLine = src.split('\n').find((l) => l.includes('$HOST_ATTRIBUTION_HOSTS -contains $procName')) ?? '';
  assert.ok(!clauseLine.includes('$lastTs'), '拒收子句不得触碰水位变量');
  assert.ok(!src.includes('$lastTs'), '不得残留逐行/终点式水位赋值（水位逐页推进）');
  assert.ok(src.includes('$watermark = $upper'), '逐页推进水位缺场');
});

// 内部任务-SYSMON-REPLAY-1：时间升序分页 + 逐页推进水位（行为面证据在真机三次连跑对拍）
test('collect-sysmon.ps1 升序分页与逐页水位（内部任务-SYSMON-REPLAY-1）', () => {
  const src = readFileSync(fileURLToPath(new URL('../adapters/os-observe/collect-sysmon.ps1', import.meta.url)), 'utf8');
  assert.ok(src.includes("TimeCreated[@SystemTime>'$watermark']"), '升序下界缺场（裸 >，PS 5.1 不接受 XML 实体）');
  assert.ok(src.includes("TimeCreated[@SystemTime<='$upper']"), '页上界缺场（裸 <=）');
  assert.ok(src.includes('$windowSec / 2'), '窗口饱和折半重试缺场');
  assert.ok(src.includes('$watermark = $upper'), '逐页推进水位缺场');
  assert.ok(src.includes('while ($pageCount -lt 40'), '页数上限缺场');
  assert.ok(src.indexOf('foreach ($e in $events)') > src.indexOf('while ($pageCount -lt 40'), '事件消费必须在页循环体内');
  assert.ok(src.indexOf('foreach ($e in $events)') < src.indexOf('$watermark = $upper'), '水位推进必须在页消费之后（数据流形态，非标识符缺场）');
  assert.ok(src.includes("$_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*'"), '空窗（PS 5.1 抛 NoMatchingEventsFound）必须按空窗推进而非冻结水位（评审 F1）缺场');
  assert.ok(src.includes('if (-not ($_.FullyQualifiedErrorId -like'), '真实读取失败仍须 break（不推进水位）缺场');
  assert.ok(src.includes('try { [void][datetime]::Parse($start) }'), '游标损坏回退守卫缺场（评审 F4）');
  assert.ok(!src.includes('$newestSeen'), '不得残留终点式水位（$newestSeen 形态）');
});

// ── 内部任务-255 批 3（N-3：内部验收-12）──

test('sysmonPrepare：路径经环境变量传参（注入字符不进入命令串）', async () => {
  const home = join(tmpdir(), `o'brien;evil-${Date.now()}`);
  const prev = process.env.OS_OBSERVE_HOME;
  const calls = [];
  try {
    process.env.OS_OBSERVE_HOME = home;
    const spawnFn = (cmd, args, opts) => {
      calls.push([cmd, args, opts]);
      if (cmd === 'powershell.exe' && String(args[2]).includes('Expand-Archive')) { fakeExe(home, Buffer.from('stub-exe')); return { status: 0, stdout: '', stderr: '' }; }
      if (cmd === 'powershell.exe') return { status: 0, stdout: JSON.stringify({ status: 'Valid', subject: 'CN=Microsoft Windows Publishing', version: '15.15', sha256: 'ab'.repeat(32) }), stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const fetchFn = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer });
    const r = await sysmonPrepare({ fetchFn, spawnFn, platform: 'win32' });
    assert.equal(r.ok, true, `prepare 应成功（收到 ${JSON.stringify(r)}）`);
    const ps = calls.filter(([c]) => c === 'powershell.exe');
    assert.ok(ps.length >= 2, '须有解压+核验两次 powershell 调用');
    for (const [, args, opts] of ps) {
      assert.ok(!String(args[2]).includes("o'brien;evil"), `命令串不得含用户路径字面量（收到 ${args[2]}）`);
      assert.ok(!String(args[2]).includes(home), '命令串不得含 home 全路径');
      assert.ok(String(args[2]).includes('$env:TG_'), '命令串须经 env 变量取值');
      const tgVals = Object.entries(opts?.env ?? {}).filter(([k, v]) => k.startsWith('TG_') && typeof v === 'string');
      assert.ok(tgVals.length > 0, 'opts.env 须携带 TG_* 路径');
      assert.ok(tgVals.some(([, v]) => v.startsWith(home)), 'env 值须为真实路径');
    }
  } finally {
    process.env.OS_OBSERVE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('sysmonEnable：含空格路径保留 Start-Process 引号语义', async () => {
  const home = join(tmpdir(), `John Doe ${Date.now()}`);
  const prev = process.env.OS_OBSERVE_HOME;
  const calls = [];
  try {
    process.env.OS_OBSERVE_HOME = home;
    mkdirSync(join(home, 'bin'), { recursive: true });
    writeFileSync(join(home, 'bin', 'collect.vbs'), "' stub");
    const spawnFn = (cmd, args, opts) => {
      calls.push([cmd, args, opts]);
      if (cmd === 'powershell.exe' && String(args[2]).includes('Expand-Archive')) { fakeExe(home, Buffer.from('stub-exe')); return { status: 0, stdout: '', stderr: '' }; }
      if (cmd === 'powershell.exe' && String(args[2]).includes('RunAs')) {
        mkdirSync(join(home, 'sysmon'), { recursive: true });
        writeFileSync(join(home, 'sysmon', 'elevated-result.txt'), '0');
        return { status: 0, stdout: '', stderr: '' };
      }
      if (cmd === 'powershell.exe') return { status: 0, stdout: JSON.stringify({ status: 'Valid', subject: 'CN=Microsoft Windows Publishing', version: '15.15', sha256: 'ab'.repeat(32) }), stderr: '' };
      if (cmd === 'sc') return { status: 0, stdout: 'STATE              :  4  RUNNING', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const fetchFn = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer });
    const r = await sysmonEnable({ fetchFn, spawnFn, platform: 'win32' });
    assert.equal(r.ok, true, `enable 应成功（收到 ${JSON.stringify(r)}）`);
    const elevated = calls.find(([c, a]) => c === 'powershell.exe' && String(a[2]).includes('RunAs'));
    assert.ok(elevated, '提权命令须含 RunAs');
    const cmd = String(elevated[1][2]);
    assert.ok(cmd.includes("('\"' + $env:TG_ELEV_PS1 + '\"')"), '提权元素须以内嵌双引号包裹 env 值（含空格路径保留引号语义）');
    assert.ok(!cmd.includes('John Doe'), '命令串不得含用户路径字面量');
    assert.ok(String(elevated[2]?.env?.TG_ELEV_PS1 ?? '').includes('sysmon-install-elevated.ps1'), 'env 携带脚本路径');
  } finally {
    process.env.OS_OBSERVE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('sysmonPrepare：路径含双引号或控制字符拒绝操作', async () => {
  const prev = process.env.OS_OBSERVE_HOME;
  try {
    let spawned = 0;
    const spawnFn = () => { spawned += 1; return { status: 0, stdout: '', stderr: '' }; };
    const fetchFn = async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer });
    for (const badHome of [join(tmpdir(), 'bad"quote-home'), join(tmpdir(), 'bad\u0085c1-home')]) {
      process.env.OS_OBSERVE_HOME = badHome;
      const r = await sysmonPrepare({ fetchFn, spawnFn, platform: 'win32' });
      assert.equal(r.ok, false, `非法字符路径须拒绝（${JSON.stringify(badHome)}）`);
      assert.ok(/非法字符/.test(String(r.error)), `错误须点名非法字符（收到 ${r.error}）`);
    }
    assert.equal(spawned, 0, '拒绝时零 spawn（不执行解压/核验）');
  } finally {
    process.env.OS_OBSERVE_HOME = prev;
  }
});

