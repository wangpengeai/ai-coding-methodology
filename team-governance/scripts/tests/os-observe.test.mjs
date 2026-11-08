// 文件：os-observe.test.mjs
// 描述：os-observation 库级测试（内部规则-9/10、内部验收-6/7、内部需求-15/16）——分类纯函数（三态
//       与优先级/viaDomain join/parse-error 降级）、记录层 store（折叠/节流基准数据/ack
//       前向机/白名单构造器/秘密兜底/游标增量）、后端注册表（内置-扩展分列/平台探测）。
// 作者：wangp  创建：2026-09-19  版权：MIT（见 team-governance/LICENSE）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  compilePattern, loadUserConfig, isValidRulePattern, appendUserRule,
  classifyDomain, buildDomainIndex, classifySample,
} from '../lib/os-observe-classify.mjs';
import {
  digestOf, makeFinding, appendFinding, readFindings, appendStatus,
  readRawSince, writeCursor, rawFreshness, osObserveHome,
} from '../lib/os-observe-store.mjs';
import { BACKENDS, probeBackend, capabilityAvailability } from '../lib/os-observe-registry.mjs';
import { syncRawToFindings } from '../lib/os-observe-pipeline.mjs';
import { TASK_NAME, install as installTask, uninstall as uninstallTask, taskQuery, statusReport } from '../lib/os-observe-tasks.mjs';
import { runOsObserve } from '../adapters/os-observe.mjs';
import { validateEnvelope } from '../adapters/contract.mjs';
import { tmpHome } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// 内部任务-337（内部未决-223）：tmpHome 收口至 tests/helpers.mjs。

// ── classify（纯函数，用户规则作参数传入，内置清单函数内建）──

test('分类三态与优先级矩阵（内部验收-6）', () => {
  assert.equal(classifyDomain('zcode.z.ai', {}).class, 'allowed');            // builtin-allow 精确
  assert.equal(classifyDomain('api.z.ai', {}).basis.rule, 'builtin-allow');   // *.z.ai 后缀
  assert.equal(classifyDomain('oss-cn-beijing.aliyuncs.com', {}).class, 'suspicious');
  assert.equal(classifyDomain('oss-cn-beijing.aliyuncs.com', {}).basis.pattern, '*.aliyuncs.com');
  assert.equal(classifyDomain('bucket.s3.amazonaws.com', {}).basis.rule, 'builtin-suspicious');
  assert.equal(classifyDomain('x.cos.ap-beijing.myqcloud.com', {}).class, 'suspicious');
  assert.equal(classifyDomain('example.com', {}).class, 'unknown');
  assert.equal(classifyDomain('example.com', {}).basis.rule, 'default-unknown');
  // 优先级：user-allow > user-suspicious > builtin-allow > builtin-suspicious
  assert.equal(classifyDomain('evil.aliyuncs.com', { userAllow: ['evil.aliyuncs.com'] }).basis.rule, 'user-allow');
  assert.equal(classifyDomain('api.z.ai', { userSuspicious: ['api.z.ai'] }).basis.rule, 'user-suspicious');
  assert.equal(
    classifyDomain('both.example.com', { userAllow: ['both.example.com'], userSuspicious: ['both.example.com'] }).class,
    'allowed'); // 同在两层用户清单：allow 压 suspicious
});

test('compilePattern 锚定全匹配且正则元字符转义', () => {
  assert.ok(compilePattern('zcode.z.ai').test('zcode.z.ai'));
  assert.ok(!compilePattern('zcode.z.ai').test('zcode-z-ai'));      // '.' 转义，不通配
  assert.ok(compilePattern('*.z.ai').test('a.z.ai'));
  assert.ok(!compilePattern('*.z.ai').test('a.z.ai.com'));          // 锚定结尾
  assert.ok(!compilePattern('*.z.ai').test('z.ai'));                // 通配须有前缀段
  assert.ok(compilePattern('*.cos.*').test('x.cos.ap-beijing.myqcloud.com'));
});

test('buildDomainIndex 只取 A/AAAA 且同 ip 取字典序最小（确定性）', () => {
  const samples = [
    { kind: 'dns', domain: 'beta.example.com', data: '203.0.113.7', qtype: 1 },
    { kind: 'dns', domain: 'alpha.example.com', data: '203.0.113.7', qtype: 28 },
    { kind: 'dns', domain: 'cname.example.com', data: 'other.example.com', qtype: 5 }, // CNAME 不进 index
    { kind: 'tcp', ip: '203.0.113.7', port: 443, processName: 'x' },
  ];
  const idx = buildDomainIndex(samples);
  assert.equal(idx.get('203.0.113.7'), 'alpha.example.com');
  assert.equal(idx.size, 1);
});

test('classifySample：tcp 经 viaDomain 判定，无 viaDomain 归 unknown（内部验收-6）', () => {
  const idx = new Map([['203.0.113.7', 'oss-cn-beijing.aliyuncs.com']]);
  const suspiciousTcp = classifySample(
    { kind: 'tcp', ip: '203.0.113.7', port: 443, processName: 'zcode.exe' }, {}, idx);
  assert.equal(suspiciousTcp.source, 'win-net-tcp-poll');
  assert.equal(suspiciousTcp.process, 'zcode.exe');
  assert.equal(suspiciousTcp.endpoint, '203.0.113.7');
  assert.equal(suspiciousTcp.endpointKind, 'ip');
  assert.equal(suspiciousTcp.viaDomain, 'oss-cn-beijing.aliyuncs.com');
  assert.equal(suspiciousTcp.class, 'suspicious');
  assert.equal(suspiciousTcp.basis.rule, 'builtin-suspicious');

  const noDomainTcp = classifySample({ kind: 'tcp', ip: '198.51.100.9', port: 443, processName: 'qoder.exe' }, {}, idx);
  assert.equal(noDomainTcp.class, 'unknown');
  assert.equal(noDomainTcp.basis.rule, 'default-unknown');
  assert.equal(noDomainTcp.viaDomain, null); // join 不成不冒充域名
});

test('classifySample：dns 行 endpoint=domain 且 process 恒 null（已知限制不伪造）', () => {
  const dns = classifySample({ kind: 'dns', domain: 'example.com', data: '203.0.113.20', qtype: 1 }, {}, new Map());
  assert.equal(dns.source, 'win-dns-cache-poll');
  assert.equal(dns.process, null);
  assert.equal(dns.endpoint, 'example.com');
  assert.equal(dns.endpointKind, 'domain');
  assert.equal(dns.class, 'unknown');
  assert.equal(dns.idInput, 'win-dns-cache-poll||example.com'); // process 空串参与 id 输入
});

test('classifySample：dnsq 行 source=win-sysmon 带进程归因（内部任务-SYSMON-1，内部规则-9）', () => {
  const q = classifySample({ kind: 'dnsq', domain: 'example.com', data: '203.0.113.20', qtype: 1, processName: 'node' }, {}, new Map());
  assert.equal(q.source, 'win-sysmon');
  assert.equal(q.process, 'node');
  assert.equal(q.endpoint, 'example.com');
  assert.equal(q.endpointKind, 'domain');
  assert.equal(q.idInput, 'win-sysmon|node|example.com');
  // 判定与 dns 同优先级：user-allow 命中 allowed；user-suspicious 次之
  const allowedQ = classifySample(
    { kind: 'dnsq', domain: 'zcode.z.ai', data: '', qtype: 0, processName: 'node' },
    { userAllow: ['zcode.z.ai'], userSuspicious: [] },
    new Map(),
  );
  assert.equal(allowedQ.class, 'allowed');
  const suspQ = classifySample(
    { kind: 'dnsq', domain: 'evil.example', data: '198.18.0.1', qtype: 1, processName: 'strange.exe' },
    { userAllow: [], userSuspicious: ['evil.example'] },
    new Map(),
  );
  assert.equal(suspQ.class, 'suspicious');
  // processName 缺省：null 不伪造（不因来源后端可归因而硬造值）
  const bare = classifySample({ kind: 'dnsq', domain: 'a.example', data: '', qtype: 0 }, {}, new Map());
  assert.equal(bare.process, null);
  assert.equal(bare.idInput, 'win-sysmon||a.example');
});

test('classifySample：样本自带 source 优先、缺省按 kind 旧映射（内部任务-OBSO-LINUX-1，内部规则-10）', () => {
  const lin = classifySample({ kind: 'tcp', ip: '203.0.113.7', port: 443, processName: 'zcode', source: 'linux-net-tcp-poll' }, {}, new Map());
  assert.equal(lin.source, 'linux-net-tcp-poll');
  assert.ok(lin.idInput.startsWith('linux-net-tcp-poll|'), `idInput 应以 linux 后端开头（收到 ${lin.idInput}）`);
  const linDnsq = classifySample({ kind: 'dnsq', domain: 'a.example', qtype: 1, source: 'linux-dns-tcpdump' }, {}, new Map());
  assert.equal(linDnsq.source, 'linux-dns-tcpdump');
  assert.ok(linDnsq.idInput.startsWith('linux-dns-tcpdump|'));
  // 缺省 source：维持既有 win 映射（向后兼容——旧样本零迁移）
  const legacy = classifySample({ kind: 'tcp', ip: '198.18.0.9', port: 80, processName: 'p' }, {}, new Map());
  assert.equal(legacy.source, 'win-net-tcp-poll');
  assert.ok(legacy.idInput.startsWith('win-net-tcp-poll|'));
});

test('classifyEndpoint：IP/CIDR 规则三态与优先级（内部任务-OBSO-LINUX-1，内部验收-16）', () => {
  const cidr = classifySample({ kind: 'tcp', ip: '203.0.113.99', port: 443 }, { userAllow: ['203.0.113.0/24'], userSuspicious: [] }, new Map());
  assert.equal(cidr.class, 'allowed');
  assert.deepEqual(cidr.basis, { rule: 'user-allow-ip', pattern: '203.0.113.0/24' });
  const exact = classifySample({ kind: 'tcp', ip: '198.51.100.7', port: 80 }, { userAllow: [], userSuspicious: ['198.51.100.7'] }, new Map());
  assert.equal(exact.class, 'suspicious');
  assert.equal(exact.basis.rule, 'user-suspicious-ip');
  const v6 = classifySample({ kind: 'tcp', ip: '2001:db8::1', port: 443 }, { userAllow: ['2001:db8::/32'], userSuspicious: [] }, new Map());
  assert.equal(v6.class, 'allowed'); // v6 前缀展开与压缩形态等价
  // 域名模式不误配 IP 端点；IP 模式不误配域名样本（两族正交）
  const domOnly = classifySample({ kind: 'tcp', ip: '10.1.2.3', port: 443 }, { userAllow: [], userSuspicious: ['*.aliyuncs.com'] }, new Map());
  assert.equal(domOnly.class, 'unknown');
  assert.equal(domOnly.basis.rule, 'default-unknown');
  const dnsUnaffected = classifySample({ kind: 'dns', domain: '203.0.113.9', qtype: 1, data: '' }, { userAllow: ['203.0.113.0/24'], userSuspicious: [] }, new Map());
  assert.equal(dnsUnaffected.class, 'unknown'); // dns 端点是域名语义，IP 规则不参与
  // 同 IP 双向命中：user-allow 优先（与域名链同序）
  const both = classifySample({ kind: 'tcp', ip: '203.0.113.5', port: 443 }, { userAllow: ['203.0.113.0/24'], userSuspicious: ['203.0.113.5'] }, new Map());
  assert.equal(both.class, 'allowed');
  assert.equal(both.basis.rule, 'user-allow-ip');
  // 无规则命中归 unknown；builtin 清单（域名-only）对 IP 端点恒不命中
  const none = classifySample({ kind: 'tcp', ip: '192.0.2.1', port: 22 }, {}, new Map());
  assert.equal(none.class, 'unknown');
  // viaDomain 存在时域名链优先，IP 规则不抢夺（Windows join 语义不变）
  const withVia = classifySample(
    { kind: 'tcp', ip: '203.0.113.7', port: 443 },
    { userAllow: [], userSuspicious: ['203.0.113.7'] },
    new Map([['203.0.113.7', 'ok.example.com']]),
  );
  assert.equal(withVia.class, 'unknown'); // 域名 ok.example.com 无规则命中 → unknown（IP suspicious 规则不介入）
  // v4-mapped 混合文本规则（::ffff:a.b.c.d）按 v4 归一——与采集器 /proc hex 归一同口径（收尾评审正确性 2）
  const mappedRule = classifySample({ kind: 'tcp', ip: '203.0.113.5', port: 443 }, { userAllow: ['::ffff:203.0.113.5'], userSuspicious: [] }, new Map());
  assert.equal(mappedRule.class, 'allowed', '::ffff: 点分混合文本规则须生效（非静默落空）');
  assert.equal(mappedRule.basis.rule, 'user-allow-ip');
});

test('classifySample：parse-error 样本降级为 unknown + lineDigest', () => {
  const pe = classifySample({ __parseError: true, lineDigest: 'abc123def4567890' }, {}, new Map());
  assert.equal(pe.class, 'unknown');
  assert.equal(pe.basis.rule, 'parse-error');
  assert.equal(pe.basis.lineDigest, 'abc123def4567890');
  assert.equal(pe.endpoint, null);
  assert.equal(pe.idInput, 'parse||abc123def4567890');
});

test('loadUserConfig：缺文件/合法/坏 JSON/非法条目四态', () => {
  const home = tmpHome('os-observe-');
  try {
    const missing = loadUserConfig(home);
    assert.equal(missing.ok, true);
    assert.deepEqual(missing.config.allow, []);
    assert.equal(missing.config.pollMinutes, 5);
    assert.equal(missing.config.surfaceDetail, false);

    writeFileSync(join(home, 'config.json'), JSON.stringify(
      { schemaVersion: 1, allow: ['ok.example.com', 42], suspicious: ['bad.example.com'], pollMinutes: 10, surfaceDetail: true }), 'utf8');
    const valid = loadUserConfig(home);
    assert.equal(valid.ok, true);
    assert.deepEqual(valid.config.allow, ['ok.example.com']); // 非字符串条目跳过
    assert.equal(valid.config.pollMinutes, 10);

    writeFileSync(join(home, 'config.json'), '{not json', 'utf8');
    const broken = loadUserConfig(home);
    assert.equal(broken.ok, false);
    assert.ok(broken.warning.length > 0);
    assert.deepEqual(broken.config.allow, []); // 退内置清单判定（内置清单在 classifyDomain 内建）
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── store（记录层唯一事实源，内部规则-10）──

test('makeFinding 白名单外键抛错、schemaVersion 恒 1（B-M14-5）', () => {
  const f = makeFinding({
    id: 'of-abc', ts: 1, source: 'win-net-tcp-poll', process: 'x.exe', endpoint: '203.0.113.7',
    endpointKind: 'ip', class: 'unknown', basis: { rule: 'default-unknown' },
    firstSeen: 1, lastSeen: 1, count: 1,
  });
  assert.equal(f.schemaVersion, 1);
  assert.equal(f.status, undefined); // 非 suspicious 不携带
  assert.throws(() => makeFinding({ id: 'of-x', ts: 1, source: 's', endpoint: 'e', endpointKind: 'domain', class: 'unknown', basis: { rule: 'default-unknown' }, firstSeen: 1, lastSeen: 1, count: 1, path: 'C:\\evil' }));
});

test('appendFinding/readFindings：同 id 末条为准、坏行跳过、缺文件空 Map', () => {
  const home = tmpHome('os-observe-');
  try {
    assert.equal(readFindings(home).size, 0);
    const base = { id: 'of-a', ts: 1, source: 's', process: null, endpoint: 'e.com', endpointKind: 'domain', class: 'unknown', basis: { rule: 'default-unknown' }, firstSeen: 1, lastSeen: 1, count: 1 };
    appendFinding(home, makeFinding(base));
    appendFinding(home, makeFinding({ ...base, ts: 2, lastSeen: 2, count: 2 }));
    appendFileSyncLine(home, '{"id":"of-b","broken"'); // 坏行
    const m = readFindings(home);
    assert.equal(m.size, 1);
    assert.equal(m.get('of-a').count, 2); // 末条为准
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('appendStatus：仅 open→acknowledged 前向、全快照携带 note、未知 id 拒绝', () => {
  const home = tmpHome('os-observe-');
  try {
    const base = { id: 'of-s', ts: 1, source: 's', process: null, endpoint: 'evil.aliyuncs.com', endpointKind: 'domain', class: 'suspicious', basis: { rule: 'builtin-suspicious', pattern: '*.aliyuncs.com' }, firstSeen: 1, lastSeen: 1, count: 1, status: 'open' };
    appendFinding(home, makeFinding(base));
    appendStatus(home, 'of-s', { status: 'acknowledged', note: '已核对为误报' });
    const acked = readFindings(home).get('of-s');
    assert.equal(acked.status, 'acknowledged');
    assert.equal(acked.note, '已核对为误报');
    assert.equal(acked.endpoint, 'evil.aliyuncs.com'); // 全快照
    assert.throws(() => appendStatus(home, 'of-s', { status: 'open' }));            // 拒绝回退
    assert.throws(() => appendStatus(home, 'of-s', { status: 'acknowledged' }));     // 重复确认拒绝
    assert.throws(() => appendStatus(home, 'of-missing', { status: 'acknowledged' })); // 未知 id
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('appendFinding 秘密兜底：白名单字段值命中秘密模式转 parse-error 行（B-M14-5）', () => {
  const home = tmpHome('os-observe-');
  try {
    const base = { id: 'of-k', ts: 1, source: 's', process: null, endpoint: 'AKIAIOSFODNN7EXAMPLE', endpointKind: 'domain', class: 'unknown', basis: { rule: 'default-unknown' }, firstSeen: 1, lastSeen: 1, count: 1 };
    appendFinding(home, makeFinding(base));
    const m = readFindings(home);
    assert.equal(m.size, 1);
    const row = [...m.values()][0];
    assert.equal(row.class, 'unknown');
    assert.equal(row.basis.rule, 'parse-error');
    const onDisk = readFileSync(join(home, 'findings.jsonl'), 'utf8');
    assert.ok(!onDisk.includes('AKIAIOSFODNN7EXAMPLE')); // 秘密字面量零泄漏
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('readRawSince：游标增量推进、只读新行（内部验收-7）', () => {
  const home = tmpHome('os-observe-');
  try {
    const raw = join(home, 'raw');
    mkdirSync(raw, { recursive: true });
    const file = join(raw, 'samples-20260919.jsonl');
    const l1 = JSON.stringify({ ts: '2026-09-19T10:00:00.000Z', kind: 'dns', domain: 'a.com', data: '1.1.1.1', qtype: 1 });
    const l2 = JSON.stringify({ ts: '2026-09-19T10:00:01.000Z', kind: 'dns', domain: 'b.com', data: '2.2.2.2', qtype: 1 });
    writeFileSync(file, `${l1}\n${l2}\n`, 'utf8');
    const r1 = readRawSince(home, { maxRows: 1 });
    assert.equal(r1.samples.length, 1);
    assert.deepEqual(r1.cursor, { file: 'samples-20260919.jsonl', line: 1 });
    writeCursor(home, r1.cursor);
    const r2 = readRawSince(home);
    assert.equal(r2.samples.length, 1);
    assert.equal(r2.samples[0].domain, 'b.com');
    assert.deepEqual(r2.cursor, { file: 'samples-20260919.jsonl', line: 2 });
    writeCursor(home, r2.cursor);
    const l3 = JSON.stringify({ ts: '2026-09-19T10:05:00.000Z', kind: 'dns', domain: 'c.com', data: '3.3.3.3', qtype: 1 });
    writeFileSync(file, `${l1}\n${l2}\n${l3}\n`, 'utf8');
    const r3 = readRawSince(home);
    assert.equal(r3.samples.length, 1);
    assert.equal(r3.samples[0].domain, 'c.com');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('readRawSince：游标损坏全量重读、坏行标记 parse-error、BOM 首行容忍', () => {
  const home = tmpHome('os-observe-');
  try {
    const raw = join(home, 'raw');
    mkdirSync(raw, { recursive: true });
    const file = join(raw, 'samples-20260919.jsonl');
    const good = JSON.stringify({ kind: 'dns', domain: 'a.com', data: '1.1.1.1', qtype: 1 });
    const good2 = JSON.stringify({ kind: 'dns', domain: 'z.com', data: '9.9.9.9', qtype: 1 });
    writeFileSync(file, `\uFEFF${good}\n{broken\n${good2}\n`, 'utf8'); // BOM + 坏行（非末行）
    writeCursor(home, { file: 'samples-20260919.jsonl', line: 99 }); // 越界=损坏
    const r = readRawSince(home);
    assert.equal(r.samples.length, 3);
    assert.equal(r.samples[0].domain, 'a.com');       // BOM 不碍解析
    assert.equal(r.samples[1].__parseError, true);    // 非末行坏行标记不丢弃
    assert.ok(r.samples[1].lineDigest.length === 16);
    assert.equal(r.samples[2].domain, 'z.com');
    assert.deepEqual(r.cursor, { file: 'samples-20260919.jsonl', line: 3 });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('readRawSince：末文件末行破行不消费（采集器并发写窗口），下轮补全后自愈（评审正确性 2）', () => {
  const home = tmpHome('os-observe-');
  try {
    const raw = join(home, 'raw');
    mkdirSync(raw, { recursive: true });
    const file = join(raw, 'samples-20260919.jsonl');
    const good = JSON.stringify({ kind: 'dns', domain: 'a.com', data: '1.1.1.1', qtype: 1 });
    writeFileSync(file, `${good}\n{"kind":"dns","dom`, 'utf8'); // 末行=写到一半的破行
    const r1 = readRawSince(home);
    assert.equal(r1.samples.length, 1);               // 破行未消费
    assert.deepEqual(r1.cursor, { file: 'samples-20260919.jsonl', line: 1 }); // 游标停在破行
    writeCursor(home, r1.cursor);
    const torn = JSON.stringify({ kind: 'dns', domain: 'half.com', data: '2.2.2.2', qtype: 1 });
    writeFileSync(file, `${good}\n${torn}\n`, 'utf8'); // 采集器写全（本轮末不再破）
    const r2 = readRawSince(home);
    assert.equal(r2.samples.length, 1);
    assert.equal(r2.samples[0].domain, 'half.com');   // 补全后按正常样本消费
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('rawFreshness：文件数/字节/最新 mtime（停滞判定共用）', () => {
  const home = tmpHome('os-observe-');
  try {
    assert.equal(rawFreshness(home).files, 0);
    const raw = join(home, 'raw');
    mkdirSync(raw, { recursive: true });
    writeFileSync(join(raw, 'samples-20260919.jsonl'), '{"kind":"dns"}\n', 'utf8');
    const f = rawFreshness(home);
    assert.equal(f.files, 1);
    assert.ok(f.bytes > 0);
    assert.ok(Math.abs(f.newestTsMs - Date.now()) < 60_000);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('osObserveHome：OS_OBSERVE_HOME 注入缝优先', () => {
  const prev = process.env.OS_OBSERVE_HOME;
  try {
    process.env.OS_OBSERVE_HOME = 'D:\\tmp\\os-observe-test';
    assert.equal(osObserveHome(), 'D:\\tmp\\os-observe-test');
    delete process.env.OS_OBSERVE_HOME;
    assert.equal(osObserveHome(), join(homedir(), '.zcode', 'os-observe'));
  } finally {
    if (prev === undefined) delete process.env.OS_OBSERVE_HOME; else process.env.OS_OBSERVE_HOME = prev;
  }
});

test('digestOf：sha256 前 16 位', () => {
  assert.match(digestOf(['a', 'b', 'c']), /^[0-9a-f]{16}$/);
});

// ── registry（后端注册表，内部决策-029 决策 2 载体）──

test('BACKENDS 恰六项且字段齐（内置-扩展分列 + Linux/darwin 增补，内部任务-OBSO-LINUX-1/内部任务-OBSO-DARWIN-1）', () => {
  assert.equal(BACKENDS.length, 6);
  const ids = BACKENDS.map((b) => b.id);
  assert.deepEqual(ids, ['win-net-tcp-poll', 'win-dns-cache-poll', 'win-sysmon', 'linux-net-tcp-poll', 'linux-dns-tcpdump', 'darwin-net-tcp-poll']);
  for (const b of BACKENDS) {
    assert.ok(b.dependency === 'builtin' || b.dependency === 'external-tool');
    assert.equal(typeof b.requiresExplicitEnable, 'boolean');
    assert.equal(typeof b.implemented, 'boolean');
    assert.ok(Array.isArray(b.platforms) && b.platforms.length > 0);
  }
  const sysmon = BACKENDS.find((b) => b.id === 'win-sysmon');
  assert.equal(sysmon.dependency, 'external-tool');
  assert.equal(sysmon.requiresExplicitEnable, true);
  assert.equal(sysmon.implemented, true); // 内部任务-SYSMON-1 翻转：登记位落成实现
  const linTcp = BACKENDS.find((b) => b.id === 'linux-net-tcp-poll');
  assert.equal(linTcp.dependency, 'builtin');
  assert.equal(linTcp.requiresExplicitEnable, false);
  assert.equal(linTcp.implemented, true);
  assert.deepEqual(linTcp.platforms, ['linux']);
  const linDns = BACKENDS.find((b) => b.id === 'linux-dns-tcpdump');
  assert.equal(linDns.dependency, 'external-tool');
  assert.equal(linDns.requiresExplicitEnable, true);
  assert.equal(linDns.implemented, true);
  assert.deepEqual(linDns.platforms, ['linux']);
  const darwinTcp = BACKENDS.find((b) => b.id === 'darwin-net-tcp-poll');
  assert.equal(darwinTcp.dependency, 'builtin');
  assert.equal(darwinTcp.requiresExplicitEnable, false);
  assert.equal(darwinTcp.implemented, true);
  assert.deepEqual(darwinTcp.platforms, ['darwin']);
});

test('probeBackend：平台匹配可用、跨平台 unavailable 且指引不含未实测命令（D5）', () => {
  assert.equal(probeBackend('win-net-tcp-poll', { platform: 'win32' }).availability, 'available');
  const linux = probeBackend('win-net-tcp-poll', { platform: 'linux' });
  assert.equal(linux.availability, 'unavailable');
  assert.ok(linux.detail.includes('仅 win32 已实测')); // 平台清单泛化（内部任务-OBSO-LINUX-1：按注册表 platforms 生成）
  for (const cmd of ['Get-NetTCPConnection', 'Get-DnsClientCache', 'schtasks', 'powershell', 'netstat', 'ipconfig']) {
    assert.ok(!linux.guidance.includes(cmd), `指引不得含未实测命令 ${cmd}`);
  }
  const sysmon = probeBackend('win-sysmon', { platform: 'win32' });
  assert.equal(sysmon.availability, 'available'); // 已实现（内部任务-SYSMON-1）：平台匹配即 available
  assert.ok(sysmon.detail.includes('DnsQuery'));   // 采样面语义
  assert.ok(sysmon.detail.includes('显式启用'));   // external-tool 仍需显式启用（sysmon status 查在装态）
  assert.equal(probeBackend('linux-net-tcp-poll', { platform: 'linux' }).availability, 'available');
  const win = probeBackend('linux-net-tcp-poll', { platform: 'win32' });
  assert.equal(win.availability, 'unavailable');
  for (const cmd of ['crontab', 'tcpdump', 'pgrep', '/proc']) {
    assert.ok(!win.guidance.includes(cmd), `指引不得含未实测命令 ${cmd}`);
  }
  assert.equal(probeBackend('linux-dns-tcpdump', { platform: 'linux' }).availability, 'available');
  assert.ok(probeBackend('linux-dns-tcpdump', { platform: 'linux' }).detail.includes('显式启用')); // external-tool 引导语义
  assert.equal(probeBackend('darwin-net-tcp-poll', { platform: 'darwin' }).availability, 'available'); // 内部任务-OBSO-DARWIN-1
  const darwinCross = probeBackend('darwin-net-tcp-poll', { platform: 'win32' });
  assert.equal(darwinCross.availability, 'unavailable');
  for (const cmd of ['lsof', 'launchctl', 'nettop']) {
    assert.ok(!darwinCross.guidance.includes(cmd), `指引不得含未实测命令 ${cmd}`);
  }
});

test('capabilityAvailability：按平台过滤内置后端集（内部任务-OBSO-LINUX-1 语义修订）', () => {
  assert.equal(capabilityAvailability({ platform: 'win32' }).availability, 'available'); // 双 win builtin，linux 项不拖累
  const lin = capabilityAvailability({ platform: 'linux' });
  assert.equal(lin.availability, 'available'); // linux builtin 单枚即足，win 项不在平台集
  assert.ok(lin.detail.includes('linux-net-tcp-poll'));
  const darwin = capabilityAvailability({ platform: 'darwin' });
  assert.equal(darwin.availability, 'available'); // darwin 自 内部任务-OBSO-DARWIN-1 入列实测平台
  assert.ok(darwin.detail.includes('darwin-net-tcp-poll'));
  const sunos = capabilityAvailability({ platform: 'sunos' });
  assert.equal(sunos.availability, 'unavailable');
  assert.ok(sunos.detail.includes('无内置后端')); // 未实测平台（D5：不提供未实测命令）——三平台入列后负例换 sunos 承接
});

// ── pipeline（raw → findings 增量物化，内部规则-10 / 内部验收-7）──

function dnsLine(domain, ip, ts) {
  return JSON.stringify({ ts, kind: 'dns', domain, data: ip, qtype: 1 });
}

function tcpLine(ip, port, processName, ts) {
  return JSON.stringify({ ts, kind: 'tcp', ip, port, processName });
}

function writeRaw(home, lines, day = '20260919') {
  mkdirSync(join(home, 'raw'), { recursive: true });
  writeFileSync(join(home, 'raw', `samples-${day}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
}

function appendRaw(home, lines, day = '20260919') {
  // 模拟下一轮采样：同域名的再次观察以新行追加（节流作用于同 id 在新行中再现）
  appendFileSync(join(home, 'raw', `samples-${day}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
}

test('pipeline：首轮全量、同批同 id 去重、firstSeen/lastSeen 取样本时间、返回计数（内部验收-7）', () => {
  const home = tmpHome('os-observe-');
  try {
    writeRaw(home, [
      dnsLine('a.example.com', '203.0.113.1', '2026-09-19T10:00:00.000Z'),
      dnsLine('a.example.com', '203.0.113.1', '2026-09-19T10:00:01.000Z'), // 同批同 id → 节流去重
      dnsLine('oss.aliyuncs.com', '203.0.113.2', '2026-09-19T10:00:02.000Z'),
      tcpLine('203.0.113.2', 443, 'zcode.exe', '2026-09-19T10:00:03.000Z'), // viaDomain join → suspicious
    ]);
    const r = syncRawToFindings(home, { now: Date.parse('2026-09-19T10:05:00.000Z') });
    assert.equal(r.scanned, 4);
    assert.equal(r.appended, 3);
    assert.equal(r.skipped, 1);
    assert.equal(r.byClass.suspicious, 2); // dns aliyuncs + tcp viaDomain
    assert.equal(r.byClass.unknown, 1);
    const m = readFindings(home);
    assert.equal(m.size, 3);
    const a = m.get(`of-${digestOf(['win-dns-cache-poll||a.example.com'])}`);
    assert.equal(a.firstSeen, Date.parse('2026-09-19T10:00:00.000Z'));
    assert.equal(a.lastSeen, Date.parse('2026-09-19T10:00:00.000Z')); // 同批去重的第二次观察不落盘
    const tcpRow = m.get(`of-${digestOf(['win-net-tcp-poll|zcode.exe|203.0.113.2'])}`);
    assert.equal(tcpRow.class, 'suspicious');
    assert.equal(tcpRow.status, 'open'); // 仅 suspicious 携带 status
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('pipeline：节流三档（allowed 24h / unknown 1h / suspicious 每轮刷新 count+1）', () => {
  const home = tmpHome('os-observe-');
  try {
    const t0 = Date.parse('2026-09-19T10:00:00.000Z');
    const allowed = dnsLine('zcode.z.ai', '203.0.113.10', '2026-09-19T10:00:00.000Z');
    const unknownD = dnsLine('x.example.com', '203.0.113.11', '2026-09-19T10:00:00.000Z');
    const suspicious = dnsLine('evil.aliyuncs.com', '203.0.113.12', '2026-09-19T10:00:00.000Z');
    writeRaw(home, [allowed, unknownD, suspicious]);
    const r1 = syncRawToFindings(home, { now: t0 });
    assert.equal(r1.appended, 3);
    appendRaw(home, [allowed, unknownD, suspicious]); // 下一轮采样：同 id 以新行再现
    const r2 = syncRawToFindings(home, { now: t0 + 60_000 }); // 1 分钟后：仅 suspicious 刷新
    assert.equal(r2.appended, 1);
    assert.equal(r2.skipped, 2);
    appendRaw(home, [allowed, unknownD, suspicious]);
    const r3 = syncRawToFindings(home, { now: t0 + 25 * 3600_000 }); // 25 小时后：全部过窗
    assert.equal(r3.appended, 3);
    const m = readFindings(home);
    const sus = m.get(`of-${digestOf(['win-dns-cache-poll||evil.aliyuncs.com'])}`);
    assert.equal(sus.count, 3); // 三轮各一行刷新
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('pipeline：类别翻转不受目标类节流（allow 后下一轮即重分类，内部任务-ALLOWCLI-1）', () => {
  const home = tmpHome('os-observe-');
  try {
    const t0 = Date.parse('2026-09-21T10:00:00.000Z');
    const line = dnsLine('evil.aliyuncs.com', '203.0.113.12', '2026-09-21T10:00:00.000Z');
    writeRaw(home, [line]);
    syncRawToFindings(home, { now: t0 });
    const id = `of-${digestOf(['win-dns-cache-poll||evil.aliyuncs.com'])}`;
    assert.equal(readFindings(home).get(id).class, 'suspicious');
    // 用户加白后下一轮采样（远小于 allowed 24h 节流窗）：翻转行必须落盘（fold 末条为准）
    writeFileSync(join(home, 'config.json'), JSON.stringify({ schemaVersion: 1, allow: ['*.aliyuncs.com'], suspicious: [], pollMinutes: 5, surfaceDetail: false }), 'utf8');
    appendRaw(home, [line]);
    const r2 = syncRawToFindings(home, { now: t0 + 60_000 });
    assert.equal(r2.appended, 1, '类别翻转行应追加（不被 allowed 24h 节流吞）');
    assert.equal(readFindings(home).get(id).class, 'allowed');
    // 同态刷新节流不变：再一轮同类样本在 24h 窗内跳过
    appendRaw(home, [line]);
    const r3 = syncRawToFindings(home, { now: t0 + 120_000 });
    assert.equal(r3.skipped, 1);
    assert.equal(readFindings(home).get(id).count, 2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('pipeline：游标推进（第二轮只读新行）', () => {
  const home = tmpHome('os-observe-');
  try {
    writeRaw(home, [dnsLine('a.example.com', '203.0.113.1', '2026-09-19T10:00:00.000Z')]);
    syncRawToFindings(home, { now: 1 });
    writeRaw(home, [
      dnsLine('a.example.com', '203.0.113.1', '2026-09-19T10:00:00.000Z'),
      dnsLine('b.example.com', '203.0.113.2', '2026-09-19T11:00:00.000Z'),
    ]);
    const r = syncRawToFindings(home, { now: 2 });
    assert.equal(r.scanned, 1); // 只读新行
    assert.equal(readFindings(home).size, 2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('pipeline：配置变更重分类（追加同 id 新 class 全快照，末条呈现现行判定）', () => {
  const home = tmpHome('os-observe-');
  try {
    writeRaw(home, [dnsLine('flagged.example.com', '203.0.113.1', '2026-09-19T10:00:00.000Z')]);
    syncRawToFindings(home, { now: 1 });
    assert.equal(readFindings(home).get(`of-${digestOf(['win-dns-cache-poll||flagged.example.com'])}`).class, 'unknown');
    writeFileSync(join(home, 'config.json'), JSON.stringify({ schemaVersion: 1, suspicious: ['flagged.example.com'] }), 'utf8');
    appendRaw(home, [dnsLine('flagged.example.com', '203.0.113.1', '2026-09-19T11:00:00.000Z')]); // 下一轮采样
    syncRawToFindings(home, { now: 2 }); // suspicious 档无节流 → 立即刷新行
    const row = readFindings(home).get(`of-${digestOf(['win-dns-cache-poll||flagged.example.com'])}`);
    assert.equal(row.class, 'suspicious');
    assert.equal(row.basis.rule, 'user-suspicious');
    assert.equal(row.status, 'open');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('pipeline：raw 坏行降级 parse-error finding（fail-toward-alert 不丢弃）', () => {
  const home = tmpHome('os-observe-');
  try {
    mkdirSync(join(home, 'raw'), { recursive: true });
    writeFileSync(join(home, 'raw', 'samples-20260919.jsonl'), '{broken line\n{"kind":"dns","domain":"ok.example.com","data":"203.0.113.9","qtype":1}\n', 'utf8');
    const r = syncRawToFindings(home, { now: 1 });
    assert.equal(r.scanned, 2); // 非末位坏行正常消费
    assert.equal(r.appended, 2);
    assert.equal(r.byClass.unknown, 2);
    const rows = readFindings(home);
    const peRow = [...rows.values()].find((f) => f.basis.rule === 'parse-error');
    assert.ok(peRow, '坏行降级为 parse-error finding');
    assert.equal(peRow.endpoint, null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── tasks（安装器，spawnFn 桩注入，不触真实 schtasks；内部规则-11 / 内部验收-8）──
// 平台注入：本组断言的是 win32 语义，一律显式 platform:'win32'——不注入时非 Windows 宿主落到实现的
// unavailable 分支（taskQuery 恒 installed:false），验证集在非 Windows 机必红（2026-09-20 实测）。

test('install：部署到稳定路径/播种幂等/schtasks 参数数组/参数白名单（内部验收-8）', () => {
  const home = tmpHome('os-observe-');
  const prev = process.env.OS_OBSERVE_HOME;
  process.env.OS_OBSERVE_HOME = home;
  const calls = [];
  const okSpawn = (cmd, args) => { calls.push([cmd, args]); return { status: 0, stderr: '', stdout: '' }; };
  try {
    const r = installTask({ pollMinutes: 5, spawnFn: okSpawn, platform: 'win32' });
    assert.equal(r.ok, true);
    assert.ok(existsSync(join(home, 'bin', 'collect.ps1')));   // 部署到稳定路径（不指向版本化插件缓存目录）
    assert.ok(existsSync(join(home, 'bin', 'collect.vbs')));   // 启动包装随内置采集器一并部署（内部任务-OSOBWIN-1）
    assert.ok(existsSync(join(home, 'raw')));
    assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).pollMinutes, 5);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'schtasks');
    const a = calls[0][1];
    assert.deepEqual(a.slice(0, 7), ['/Create', '/TN', TASK_NAME, '/SC', 'MINUTE', '/MO', '5']);
    const tr = a[a.indexOf('/TR') + 1];
    assert.ok(tr.startsWith('wscript.exe //nologo "')); // GUI 宿主包装，不直启控制台子系统（防闪窗）
    assert.ok(tr.includes(join(home, 'bin', 'collect.vbs')));
    assert.equal(a[a.length - 1], '/F'); // 幂等=覆写式注册
    // 播种不覆写用户字段；注册值与 config 对账（评审正确性 3）：pollMinutes 更新、allow 保留
    writeFileSync(join(home, 'config.json'), JSON.stringify({ schemaVersion: 1, allow: ['mine.example.com'], suspicious: [], pollMinutes: 9, surfaceDetail: false }), 'utf8');
    installTask({ pollMinutes: 60, spawnFn: okSpawn, platform: 'win32' });
    const cfgAfter = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
    assert.equal(cfgAfter.allow[0], 'mine.example.com'); // 用户字段保留
    assert.equal(cfgAfter.pollMinutes, 60);              // 注册值对账更新（防假停滞/漏停滞）
    // 参数白名单 1..1439
    assert.equal(installTask({ pollMinutes: 0, spawnFn: okSpawn, platform: 'win32' }).usage, true);
    assert.equal(installTask({ pollMinutes: 1440, spawnFn: okSpawn, platform: 'win32' }).usage, true);
    // schtasks 非零退出 → 内容失败可见
    assert.equal(installTask({ pollMinutes: 5, spawnFn: () => ({ status: 1, stderr: 'boom' }), platform: 'win32' }).ok, false);
    // 未实测平台桩 → unavailable（不写未实测命令；linux 2026-09-20、darwin 2026-09-30 入列实测平台，负例换 sunos）
    const nonWin = installTask({ pollMinutes: 5, spawnFn: okSpawn, platform: 'sunos' });
    assert.equal(nonWin.ok, false);
    assert.equal(nonWin.availability, 'unavailable');
  } finally {
    if (prev === undefined) delete process.env.OS_OBSERVE_HOME; else process.env.OS_OBSERVE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('uninstall：对称移除（参数数组）、任务不存在按已移除、非零失败可见', () => {
  const calls = [];
  const okSpawn = (cmd, args) => { calls.push([cmd, args]); return { status: 0, stderr: '', stdout: '' }; };
  assert.equal(uninstallTask({ spawnFn: okSpawn, platform: 'win32' }).ok, true);
  assert.deepEqual(calls[0], ['schtasks', ['/Delete', '/TN', TASK_NAME, '/F']]);
  assert.equal(uninstallTask({ spawnFn: () => ({ status: 1, stderr: 'not found' }), platform: 'win32' }).ok, true); // 退出码 1=不存在→幂等
  const failed = uninstallTask({ spawnFn: () => ({ status: 2, stderr: 'denied' }), platform: 'win32' });
  assert.equal(failed.ok, false);
  assert.ok(failed.error.includes('schtasks'));
});

test('taskQuery：退出码 0=在册、非零=不在册', () => {
  assert.equal(taskQuery({ spawnFn: () => ({ status: 0 }), platform: 'win32' }).installed, true);
  assert.equal(taskQuery({ spawnFn: () => ({ status: 1 }), platform: 'win32' }).installed, false);
});

test('statusReport：聚合任务在册/配置/发现计数/新鲜度/部署脚本对拍', () => {
  const home = tmpHome('os-observe-');
  const prev = process.env.OS_OBSERVE_HOME;
  process.env.OS_OBSERVE_HOME = home;
  try {
    writeRaw(home, [dnsLine('evil.aliyuncs.com', '203.0.113.1', '2026-09-19T10:00:00.000Z')]);
    syncRawToFindings(home, { now: Date.parse('2026-09-19T10:00:05.000Z') });
    installTask({ pollMinutes: 5, spawnFn: () => ({ status: 0, stderr: '', stdout: '' }), platform: 'win32' }); // 真复制部署脚本
    const mtime = statSync(join(home, 'raw', 'samples-20260919.jsonl')).mtimeMs;
    const s = statusReport({ spawnFn: () => ({ status: 0 }), now: () => mtime + 60_000, platform: 'win32' });
    assert.equal(s.ok, true);
    assert.equal(s.installed, true);
    assert.equal(s.findings.openSuspicious, 1);
    assert.equal(s.findings.byClass.suspicious, 1);
    assert.equal(s.raw.stale, false); // 采样后 1 分钟 → 新鲜
    assert.equal(s.deployedScript.matchesShipped, true); // 部署副本与插件内置逐字节一致
    assert.equal(s.wrapperScript.matchesShipped, true); // 启动包装部署=内置 对拍（内部任务-OSOBWIN-1）
    const stale = statusReport({ spawnFn: () => ({ status: 0 }), now: () => mtime + 40 * 60_000, platform: 'win32' });
    assert.equal(stale.raw.stale, true); // 超 max(2×pollMinutes,30min) 未更新
  } finally {
    if (prev === undefined) delete process.env.OS_OBSERVE_HOME; else process.env.OS_OBSERVE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

// ── adapter（只读面：读 findings 产 内部接口-1 信封，github-ci 同构；内部规则-9 / 内部验收-9）──

test('adapter：win32 空数据（未安装态）→ unavailable + unverified，信封过 validateEnvelope', () => {
  const home = tmpHome('os-observe-');
  try {
    const r = runOsObserve({ home, platform: 'win32', now: 1 });
    assert.equal(r.envelope.schemaVersion, '1.0.0');
    assert.equal(r.envelope.adapter, 'os-observe');
    assert.equal(r.envelope.capability, 'os-observation');
    assert.equal(r.envelope.availability, 'unavailable');
    assert.equal(r.envelope.result.status, 'unverified');
    assert.deepEqual(validateEnvelope(r.envelope), []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('adapter：open suspicious → failed + available（raw 新鲜）', () => {
  const home = tmpHome('os-observe-');
  try {
    writeRaw(home, [dnsLine('evil.aliyuncs.com', '203.0.113.1', '2026-09-19T10:00:00.000Z')]);
    const mtime = statSync(join(home, 'raw', 'samples-20260919.jsonl')).mtimeMs;
    const r = runOsObserve({ home, platform: 'win32', now: () => mtime + 60_000 });
    assert.equal(r.envelope.availability, 'available');
    assert.equal(r.envelope.result.status, 'failed');
    assert.ok(r.envelope.result.summary.includes('1'));
    assert.match(r.envelope.result.digest, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(validateEnvelope(r.envelope), []);
    assert.deepEqual(r.envelope.externalEffects, []); // 只读面零外部副作用
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('adapter：raw 停滞 → degraded + summary 标采集停滞（不伪装 passed/available）', () => {
  const home = tmpHome('os-observe-');
  try {
    writeRaw(home, [dnsLine('a.example.com', '203.0.113.1', '2026-09-19T10:00:00.000Z')]);
    const mtime = statSync(join(home, 'raw', 'samples-20260919.jsonl')).mtimeMs;
    const r = runOsObserve({ home, platform: 'win32', now: () => mtime + 40 * 60_000 });
    assert.equal(r.envelope.availability, 'degraded');
    assert.ok(r.envelope.result.summary.includes('停滞'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('adapter：无 open suspicious（unknown/已 ack）→ passed', () => {
  const home = tmpHome('os-observe-');
  try {
    writeRaw(home, [dnsLine('a.example.com', '203.0.113.1', '2026-09-19T10:00:00.000Z'), dnsLine('evil.aliyuncs.com', '203.0.113.2', '2026-09-19T10:00:00.000Z')]);
    const mtime = statSync(join(home, 'raw', 'samples-20260919.jsonl')).mtimeMs;
    const run = () => runOsObserve({ home, platform: 'win32', now: () => mtime + 60_000 });
    assert.equal(run().envelope.result.status, 'failed'); // suspicious 未确认
    const id = `of-${digestOf(['win-dns-cache-poll||evil.aliyuncs.com'])}`;
    appendRaw(home, [dnsLine('evil.aliyuncs.com', '203.0.113.2', '2026-09-19T10:01:00.000Z')]); // 下一轮采样以驱动刷新行
    appendStatus(home, id, { status: 'acknowledged', note: '已核对' });
    const r2 = run();
    assert.equal(r2.envelope.result.status, 'passed'); // 全部 unknown 或已确认
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('adapter：非 win32 → unavailable + unverified，summary 不含未实测命令（D5）', () => {
  const home = tmpHome('os-observe-');
  try {
    const r = runOsObserve({ home, platform: 'linux', now: 1 });
    assert.equal(r.envelope.availability, 'unavailable');
    assert.equal(r.envelope.result.status, 'unverified');
    for (const cmd of ['Get-NetTCPConnection', 'Get-DnsClientCache', 'schtasks', 'powershell']) {
      assert.ok(!r.envelope.result.summary.includes(cmd), `summary 不得含未实测命令 ${cmd}`);
    }
    assert.deepEqual(validateEnvelope(r.envelope), []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('pipeline：真实采集样本方言回归（内部任务-OSOBS-1 实测回落 fixture）', () => {
  // 实测 2026-09-19 本机 collect.ps1 输出：键序与 ps1 ConvertTo-Json 实际形态一致（与合成夹具不同序）
  const fixture = readFileSync(join(HERE, 'fixtures', 'os-observe', 'real-sample-line.jsonl'), 'utf8');
  const samples = fixture.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(samples.length, 2);
  const idx = buildDomainIndex(samples);
  for (const s of samples) {
    const c = classifySample(s, {}, idx);
    assert.ok(['allowed', 'suspicious', 'unknown'].includes(c.class));
    assert.equal(typeof c.endpoint, 'string');
    assert.ok(c.endpoint.length > 0);
    assert.ok(c.idInput.length > 0);
  }
});

test('appendStatus：note 命中秘密模式整体脱敏（与 appendFinding 同防线，评审正确性 5）', () => {
  const home = tmpHome('os-observe-');
  try {
    const base = { id: 'of-n', ts: 1, source: 's', process: null, endpoint: 'evil.aliyuncs.com', endpointKind: 'domain', class: 'suspicious', basis: { rule: 'builtin-suspicious', pattern: '*.aliyuncs.com' }, firstSeen: 1, lastSeen: 1, count: 1, status: 'open' };
    appendFinding(home, makeFinding(base));
    appendStatus(home, 'of-n', { status: 'acknowledged', note: 'key AKIAIOSFODNN7EXAMPLE leaked' });
    const row = readFindings(home).get('of-n');
    assert.equal(row.status, 'acknowledged');
    assert.equal(row.note, '<redacted:secret>');
    const onDisk = readFileSync(join(home, 'findings.jsonl'), 'utf8');
    assert.ok(!onDisk.includes('AKIAIOSFODNN7EXAMPLE'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('pipeline：游标后置落盘（at-least-once）——物化中途失败游标不推进，重跑全量补齐（评审正确性 1）', () => {
  const home = tmpHome('os-observe-');
  try {
    writeRaw(home, [
      dnsLine('a.example.com', '203.0.113.1', '2026-09-19T10:00:00.000Z'),
      dnsLine('b.example.com', '203.0.113.2', '2026-09-19T10:00:01.000Z'),
    ]);
    // 让 findings.jsonl 成为目录：appendFileSync 必失败 → sync 抛错
    mkdirSync(join(home, 'findings.jsonl'));
    assert.throws(() => syncRawToFindings(home, { now: 1 }));
    assert.equal(existsSync(join(home, 'raw', 'cursor.json')), false); // 游标未落盘
    rmSync(join(home, 'findings.jsonl'), { recursive: true, force: true });
    const r = syncRawToFindings(home, { now: 2 }); // 重跑：全批重读补齐
    assert.equal(r.appended, 2);
    assert.equal(readFindings(home).size, 2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

// ── 辅助 ──

function appendFileSyncLine(home, line) {
  // 直接追加未经 store 的行（模拟外部多写者/损坏行），测试专用
  appendFileSync(join(home, 'findings.jsonl'), `${line}\n`, 'utf8');
}

// ── 机会式补位采集（内部任务-OBSO-COLLECT-1，内部验收-13）──

test('opportunisticCollect：部署面两脚本齐→恰序各跑一轮（6s 超时）；无部署零 spawn', async () => {
  const { opportunisticCollect } = await import('../lib/os-observe-tasks.mjs');
  const home = tmpHome('os-observe-');
  const prev = process.env.OS_OBSERVE_HOME;
  try {
    process.env.OS_OBSERVE_HOME = home;
    // 无部署面：零 spawn
    const calls0 = [];
    let r = opportunisticCollect({ spawnFn: (c, a) => { calls0.push([c, a]); return { status: 0, stdout: '', stderr: '' }; }, platform: 'win32' });
    assert.equal(r.ran.length, 0);
    assert.equal(calls0.length, 0);
    // 两脚本齐：恰两条 powershell，-File 各指脚本，带 6000ms 超时
    mkdirSync(join(home, 'bin'), { recursive: true });
    writeFileSync(join(home, 'bin', 'collect.ps1'), '# stub');
    writeFileSync(join(home, 'bin', 'collect-sysmon.ps1'), '# stub');
    const calls = [];
    r = opportunisticCollect({ spawnFn: (c, a, o) => { calls.push([c, a, o]); return { status: 0, stdout: '', stderr: '' }; }, platform: 'win32' });
    assert.deepEqual(r.ran, ['collect.ps1', 'collect-sysmon.ps1']);
    assert.equal(calls.length, 2);
    for (const [c, a, o] of calls) {
      assert.equal(c, 'powershell.exe');
      assert.ok(String(a[6]).endsWith('.ps1'));
      assert.equal(o.timeout, 6000);
      assert.equal(o.windowsHide, true); // CREATE_NO_WINDOW：GUI 宿主 spawn 控制台子系统不闪窗（内部任务-OSOBWIN-1）
    }
    // 只部署其一：只跑其一
    rmSync(join(home, 'bin', 'collect.ps1'));
    const calls2 = [];
    r = opportunisticCollect({ spawnFn: (c, a) => { calls2.push([c, a]); return { status: 0, stdout: '', stderr: '' }; }, platform: 'win32' });
    assert.deepEqual(r.ran, ['collect-sysmon.ps1']);
    assert.equal(calls2.length, 1);
    // 未实测平台零 spawn（负例换 sunos——linux/darwin 均已有 PLAN；此处部署面亦无其脚本）
    r = opportunisticCollect({ spawnFn: () => { throw new Error('不应触达'); }, platform: 'sunos' });
    assert.equal(r.ran.length, 0);
  } finally {
    process.env.OS_OBSERVE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('opportunisticCollect：脚本超时/抛错 fail-open，后续脚本照跑', async () => {
  const { opportunisticCollect } = await import('../lib/os-observe-tasks.mjs');
  const home = tmpHome('os-observe-');
  const prev = process.env.OS_OBSERVE_HOME;
  try {
    process.env.OS_OBSERVE_HOME = home;
    mkdirSync(join(home, 'bin'), { recursive: true });
    writeFileSync(join(home, 'bin', 'collect.ps1'), '# stub');
    writeFileSync(join(home, 'bin', 'collect-sysmon.ps1'), '# stub');
    const ran = [];
    const r = opportunisticCollect({
      spawnFn: (c, a) => {
        const f = String(a[6]);
        ran.push(f);
        if (f.endsWith('collect.ps1')) throw Object.assign(new Error('ETIMEDOUT'), { killed: true });
        return { status: 0, stdout: '', stderr: '' };
      },
      platform: 'win32',
    });
    assert.deepEqual(r.ran, ['collect.ps1', 'collect-sysmon.ps1']); // ran=尝试执行面（不含成败）
    assert.equal(ran.length, 2); // 第一个超时后第二个照跑
  } finally {
    process.env.OS_OBSERVE_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test('isValidRulePattern：域名 glob/IP/CIDR 受纳，注入面拒绝（内部任务-ALLOWCLI-1）', () => {
  assert.equal(isValidRulePattern('*.aliyuncs.com'), true);
  assert.equal(isValidRulePattern('dashscope.aliyuncs.com'), true);
  assert.equal(isValidRulePattern('2408:400a:3e::1'), true);
  assert.equal(isValidRulePattern('2408:400a::/32'), true);
  assert.equal(isValidRulePattern('10.0.0.0/8'), true);
  assert.equal(isValidRulePattern(''), false);
  assert.equal(isValidRulePattern('has space.example.com'), false);
  assert.equal(isValidRulePattern('a"b.example.com'), false);
  assert.equal(isValidRulePattern('a;b'), false);
  assert.equal(isValidRulePattern('a'.repeat(254)), false);
  assert.equal(isValidRulePattern(' 1.2.3.4'), false); // 首尾空白在 IP 分支也不得漏过（终审正确性 3）
});

test('appendUserRule：幂等追加/字段保留/deny 映射/坏形态失败可见（内部任务-ALLOWCLI-1）', () => {
  const home = tmpHome('os-observe-');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ schemaVersion: 1, allow: ['keep.example.com'], suspicious: [], pollMinutes: 15, surfaceDetail: true }), 'utf8');
  // allow 追加：既有 allow 项保留、其余字段原样
  let r = appendUserRule({ kind: 'allow', pattern: '*.aliyuncs.com', home });
  assert.equal(r.added, true);
  const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  assert.deepEqual(cfg.allow, ['keep.example.com', '*.aliyuncs.com']);
  assert.equal(cfg.pollMinutes, 15);
  assert.equal(cfg.surfaceDetail, true);
  // 幂等：重复追加 no-op 不落盘
  r = appendUserRule({ kind: 'allow', pattern: '*.aliyuncs.com', home });
  assert.equal(r.added, false);
  assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).allow.length, 2);
  // deny → suspicious 数组
  appendUserRule({ kind: 'deny', pattern: 'evil.example.com', home });
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).suspicious, ['evil.example.com']);
  // 大写 pattern 小写归一落盘（DNS 大小写不敏感语义——防「校验收下、匹配不认」的静默死规则，终审正确性 2）；
  // 归一后与既有小写条目幂等（不重复追加）
  const upper = appendUserRule({ kind: 'allow', pattern: '*.ALIYUNCS.COM', home });
  assert.equal(upper.added, false, '大写归一后与既有小写条目幂等');
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).allow, ['keep.example.com', '*.aliyuncs.com']);
  // 冷列表的大写条目同样归一落盘
  const home2 = tmpHome('os-observe-');
  mkdirSync(home2, { recursive: true });
  writeFileSync(join(home2, 'config.json'), JSON.stringify({ schemaVersion: 1, allow: [], suspicious: [] }), 'utf8');
  appendUserRule({ kind: 'allow', pattern: '*.ALIYUNCS.COM', home: home2 });
  assert.deepEqual(JSON.parse(readFileSync(join(home2, 'config.json'), 'utf8')).allow, ['*.aliyuncs.com']);
  rmSync(home2, { recursive: true, force: true });
  // 坏 pattern / 坏类别 / 坏 config：抛错不落盘
  assert.throws(() => appendUserRule({ kind: 'allow', pattern: 'bad pattern!', home }), /非法 pattern/);
  assert.throws(() => appendUserRule({ kind: 'other', pattern: 'a.example.com', home }), /未知规则类别/);
  writeFileSync(join(home, 'config.json'), '{broken', 'utf8');
  assert.throws(() => appendUserRule({ kind: 'allow', pattern: 'a.example.com', home }), /config\.json/);
  rmSync(home, { recursive: true, force: true });
});

// ── 内部任务-257（P5-3）：session-start 零样本/失败留痕从句 ──
test('session-start：零样本判停滞并出从句', () => {
  const home = mkdtempSync(join(tmpdir(), 'os-session-'));
  try {
    mkdirSync(join(home, 'raw'), { recursive: true });
    writeFileSync(join(home, 'raw', 'last-error.json'),
      JSON.stringify({ ts: new Date().toISOString(), phase: 'main', error: 'injected failure' }), 'utf8');
    const r = spawnSync(process.execPath, [resolve(HERE, '..', '..', 'hooks', 'session-start.mjs')], {
      encoding: 'utf8',
      input: '{}',
      env: { ...process.env, OS_OBSERVE_HOME: home },
    });
    assert.equal(r.status, 0, 'fail-open 恒 0');
    assert.match(r.stdout + r.stderr, /无样本|最近采集失败/, '零样本/失败留痕须出可见从句（不冒充无数据）');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('session-start：AI_CODING_OS_OBSERVE=0 跳过 os-observe 段', () => {
  const home = mkdtempSync(join(tmpdir(), 'os-switch-'));
  try {
    // seed 一条 open suspicious finding：缺省态必须出现 os-observe 浮现段（保证断言有判别力）
    const ts = new Date().toISOString();
    writeFileSync(join(home, 'findings.jsonl'), `${JSON.stringify({ id: 'of-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ts, source: 'win-dns-cache-poll', process: null, endpoint: 'evil.example.com', endpointKind: 'domain', class: 'suspicious', basis: { rule: 'builtin-suspicious' }, firstSeen: ts, lastSeen: ts, count: 1, status: 'open' })}\n`, 'utf8');
    const run = (extra) => spawnSync(process.execPath, [resolve(HERE, '..', '..', 'hooks', 'session-start.mjs')], {
      encoding: 'utf8',
      input: '{}',
      env: { ...process.env, OS_OBSERVE_HOME: home, ...extra },
      timeout: 25_000,
    });
    const on = run({});
    assert.equal(on.status, 0);
    assert.match(on.stdout, /os-observe/, '缺省态必须输出 os-observe 浮现段（夹具判别力）');
    const off = run({ AI_CODING_OS_OBSERVE: '0' });
    assert.equal(off.status, 0, 'fail-open 恒 0');
    assert.doesNotMatch(off.stdout, /os-observe/, '开关=0 时不得输出 os-observe 段');
    const one = run({ AI_CODING_OS_OBSERVE: '1' });
    assert.equal(one.status, 0);
    assert.match(one.stdout, /os-observe/, '其余取值（1）保持现行两段式（不得过度关闭）');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

