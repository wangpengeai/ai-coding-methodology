// 文件：os-observe-linux-dns.test.mjs
// 描述：os-observation linux-dns-tcpdump 扩展位测试（内部规则-9/11、内部验收-17，
//       内部任务-OBSO-LINUX-1，NFR-tg-supplychain）——转换器 pcap 字节在测试内构造
//       （SLL/SLL2/Ethernet 链路、UDP/TCP 53、QR 过滤、坏包跳过、增量游标、轮回复位、
//       四魔数双端序变体；子进程注入 OS_OBSERVE_HOME）+ 启用链注入缝（guide 四要素/
//       prepare 未核验不落账三拒/enable root+user crontab 双写复核与 %%s 转义/uid 两形态/
//       disable 幂等/status fail-open 对拍）。任意宿主平台可跑（内部未决-32 纪律）；例外＝两个
//       dnsEnable 用例依赖真实 POSIX 权限位（win32 无 exec 位语义），平台条件跳过（内部任务-284）。
// 作者：wangp  创建：2026-09-20  版权：MIT（见 team-governance/LICENSE）
// 内部任务-337（内部未决-223/252②③）：tmpHome 收口至 helpers.mjs、rpm/dpkg 桩与 dnsRoot 三明治收敛至
// dns-fixtures.mjs/helpers.enterEnv（2026-11-06）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { dnsGuide, dnsPrepare, dnsEnable, dnsDisable, dnsStatus, DNS_ROOT_MARKER, DNS_USER_MARKER } from '../adapters/os-observe-linux-dns.mjs';
import { dnsBaseSpawn, newDnsRoot } from './dns-fixtures.mjs';
import { enterEnv, tmpHome } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIPPED_CONVERTER = join(HERE, '..', 'adapters', 'os-observe', 'collect-linux-dns.mjs');

// win32 无 POSIX 可执行位语义（fs.chmod 只映射只读属性：chmod 0755 后 statSync mode 实测恒 0666）
// ⇒ 两个 dnsEnable 用例依赖真实 fs 权限位（实现侧 carrierOk 复核 + mode 断言），win32 真实 fs 无法
// 取证；平台条件跳过，POSIX 宿主照常覆盖（先例 check-freeze.test.mjs:125 的 skip 选项形态）。
const POSIX_FS_SKIP = process.platform === 'win32'
  ? 'win32 无 POSIX 可执行位语义（chmod exec 位不可表示）——dnsEnable 真实 fs 取证仅 POSIX 宿主可跑（内部任务-284）'
  : false;

// ── pcap 构造 helper（测试内造字节，不落二进制 fixture）──

/** DNS 查询/响应报文（问题节逐标签，无压缩指针）。 */
function dnsMessage(domain, qtype, qr) {
  const labels = domain.split('.').map((s) => Buffer.from([s.length, ...Buffer.from(s, 'latin1')]));
  const qname = Buffer.concat([...labels, Buffer.from([0])]);
  const m = Buffer.alloc(12 + qname.length + 4);
  m.writeUInt16BE(0x1234, 0);
  m.writeUInt16BE(qr ? 0x8180 : 0x0100, 2); // QR 位
  m.writeUInt16BE(1, 4); // QDCOUNT
  qname.copy(m, 12);
  m.writeUInt16BE(qtype, 12 + qname.length);
  m.writeUInt16BE(1, 12 + qname.length + 2); // QCLASS=IN
  return m;
}

function tcpSeg(payload) {
  // DNS-over-TCP（RFC 7766）：2 字节报文长度前缀 + DNS 报文（阶段门 B P4 修正帧格式）
  const len2 = Buffer.alloc(2);
  len2.writeUInt16BE(payload.length);
  const t = Buffer.alloc(20);
  t.writeUInt16BE(5353, 0); // sport（非 53——查询方向）
  t.writeUInt16BE(53, 2);   // dport 53
  t[12] = 0x50;             // data offset 5
  return Buffer.concat([t, len2, payload]);
}

/** 一条采集记录：链路头 + IP + (UDP|TCP) + DNS。 */
function rec(dns, { tcp = false, v6 = false, link = 'sll' } = {}) {
  let transport;
  if (tcp) transport = tcpSeg(dns);
  else {
    const u = Buffer.alloc(8);
    u.writeUInt16BE(5353, 0);
    u.writeUInt16BE(53, 2);
    u.writeUInt16BE(8 + dns.length, 4);
    transport = Buffer.concat([u, dns]);
  }
  let ip;
  if (!v6) {
    const ih = Buffer.alloc(20);
    ih[0] = 0x45;
    ih.writeUInt16BE(20 + transport.length, 2);
    ih[8] = 64;
    ih[9] = tcp ? 6 : 17;
    ip = Buffer.concat([ih, transport]);
  } else {
    const h = Buffer.alloc(40);
    h[0] = 0x60;
    h.writeUInt16BE(transport.length, 4);
    h[6] = tcp ? 6 : 17;
    ip = Buffer.concat([h, transport]);
  }
  if (link === 'sll') {
    const s = Buffer.alloc(16);
    s.writeUInt16BE(v6 ? 0x86dd : 0x0800, 14);
    return Buffer.concat([s, ip]);
  }
  if (link === 'sll2') {
    const s = Buffer.alloc(20);
    s.writeUInt16BE(v6 ? 0x86dd : 0x0800, 0);
    return Buffer.concat([s, ip]);
  }
  const e = Buffer.alloc(14);
  e.writeUInt16BE(v6 ? 0x86dd : 0x0800, 12);
  return Buffer.concat([e, ip]);
}

/** pcap 文件字节：全局头 + 记录数组 [[sec, frac, pkt], …]（全部字段按文件端序写——真实 pcap 形态）。 */
function pcapFile(records, { network = 113, nano = false, endian = 'BE' } = {}) {
  const gh = Buffer.alloc(24);
  const magic = nano ? 0xa1b23c4d : 0xa1b2c3d4;
  if (endian === 'BE') gh.writeUInt32BE(magic, 0); else gh.writeUInt32LE(magic, 0);
  gh.writeUInt16BE(2, 4); gh.writeUInt16BE(4, 6);
  if (endian === 'BE') gh.writeUInt32BE(network, 20); else gh.writeUInt32LE(network, 20);
  const body = [];
  for (const [sec, frac, pkt] of records) {
    const rh = Buffer.alloc(16);
    const w32 = (val, off) => (endian === 'BE' ? rh.writeUInt32BE(val >>> 0, off) : rh.writeUInt32LE(val >>> 0, off));
    w32(sec, 0); w32(frac, 4); w32(pkt.length, 8); w32(pkt.length, 12);
    body.push(rh, pkt);
  }
  return Buffer.concat([gh, ...body]);
}

function runConverter(home, dnsRoot) {
  return spawnSync(process.execPath, [SHIPPED_CONVERTER], {
    encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, OS_OBSERVE_HOME: home, OS_OBSERVE_DNS_ROOT: dnsRoot },
  });
}

function readSamples(home) {
  const dir = join(home, 'raw');
  const lines = [];
  for (const f of readdirSync(dir).sort()) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (line.trim()) lines.push(JSON.parse(line));
    }
  }
  return lines;
}

// ── 转换器（内部验收-17 采样面）──

test('collect-linux-dns：问题节解析/QR 过滤/变体/游标增量（fixture spool）', () => {
  const home = tmpHome('os-observe-dns-');
  const dnsRoot = mkdtempSync(join(tmpdir(), 'os-observe-dnsroot-'));
  const spool = join(dnsRoot, 'dns-spool'); // H10 迁移（内部任务-281）：spool 在 root 属主载体目录（OS_OBSERVE_DNS_ROOT 注入缝）
  mkdirSync(spool, { recursive: true });
  try {
    const q1 = rec(dnsMessage('alpha.example.com', 1, false));               // UDP 查询 A
    const q2 = rec(dnsMessage('beta.example.org', 28, false));               // UDP 查询 AAAA
    const resp = rec(dnsMessage('alpha.example.com', 1, true));              // 响应（QR=1）——不得重复出样本
    const notIp = Buffer.concat([Buffer.alloc(16), Buffer.from([0x00, 0x35])]); // ethertype 非 IP
    writeFileSync(join(spool, 'dns-1.pcap'), pcapFile([
      [1700000000, 500_000, q1],
      [1700000001, 250_000, q2],
      [1700000002, 0, resp],
      [1700000003, 0, notIp],
    ]));
    const tcpQ = rec(dnsMessage('gamma.net', 1, false), { tcp: true });      // TCP/53 查询
    writeFileSync(join(spool, 'dns-2.pcap'), pcapFile([[1700000010, 0, tcpQ]]));
    let r = runConverter(home, dnsRoot);
    assert.equal(r.status, 0, `转换器须退 0（stderr=${r.stderr}）`);
    const lines = readSamples(home);
    assert.equal(lines.length, 3, `恰 3 样本（QR=1 与非 IP 不采——收到 ${lines.length}）`);
    assert.deepEqual(lines.map((l) => l.domain).sort(), ['alpha.example.com', 'beta.example.org', 'gamma.net']);
    for (const l of lines) {
      assert.equal(l.kind, 'dnsq');
      assert.equal(l.source, 'linux-dns-tcpdump');
      assert.ok(Number.isFinite(Date.parse(l.ts)));
    }
    assert.equal(lines.find((l) => l.domain === 'alpha.example.com').qtype, 1);
    assert.equal(lines.find((l) => l.domain === 'gamma.net').qtype, 1);
    const ts = Date.parse(lines.find((l) => l.domain === 'beta.example.org').ts);
    assert.equal(ts, 1700000001250); // sec*1000 + usec/1000
    const cursor = JSON.parse(readFileSync(join(home, 'dns', 'cursor.json'), 'utf8'));
    assert.equal(cursor.files['dns-1.pcap'], readFileSync(join(spool, 'dns-1.pcap')).length, '游标=完整末尾');
    // 增量：追加一条新查询 → 重跑仅 +1
    const f1 = readFileSync(join(spool, 'dns-1.pcap'));
    const q3 = rec(dnsMessage('delta.io', 1, false));
    const rh = Buffer.alloc(16);
    rh.writeUInt32BE(1700000020, 0); rh.writeUInt32BE(0, 4); rh.writeUInt32BE(q3.length, 8); rh.writeUInt32BE(q3.length, 12);
    writeFileSync(join(spool, 'dns-1.pcap'), Buffer.concat([f1, rh, q3]));
    r = runConverter(home, dnsRoot);
    assert.equal(r.status, 0);
    assert.equal(readSamples(home).length, 4, '增量恰 +1');
    // 轮回复位：重写为更短文件 → 不崩、样本按新内容计
    writeFileSync(join(spool, 'dns-1.pcap'), pcapFile([[1700000030, 0, q1]]));
    rmSync(join(home, 'raw'), { recursive: true, force: true });
    r = runConverter(home, dnsRoot);
    assert.equal(r.status, 0);
    assert.equal(readSamples(home).length, 1, '收缩复位后按新内容重读');
    // 游标清洗：登记一个已消失的文件条目 → 重跑后条目被移除
    const c2 = JSON.parse(readFileSync(join(home, 'dns', 'cursor.json'), 'utf8'));
    c2.files['dns-gone.pcap'] = 100;
    writeFileSync(join(home, 'dns', 'cursor.json'), `${JSON.stringify(c2)}\n`);
    runConverter(home, dnsRoot);
    const c3 = JSON.parse(readFileSync(join(home, 'dns', 'cursor.json'), 'utf8'));
    assert.equal(c3.files['dns-gone.pcap'], undefined, '消失文件条目清洗');
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(dnsRoot, { recursive: true, force: true }); }
});

test('collect-linux-dns：SLL2/Ethernet/纳秒/LE 端序变体与坏容错', () => {
  const home = tmpHome('os-observe-dns-');
  const dnsRoot = mkdtempSync(join(tmpdir(), 'os-observe-dnsroot-'));
  const spool = join(dnsRoot, 'dns-spool');
  mkdirSync(spool, { recursive: true });
  try {
    const q = dnsMessage('v6.example.net', 28, false);
    writeFileSync(join(spool, 'a-sll2.pcap'), pcapFile([[1700000000, 0, rec(q, { link: 'sll2' })]], { network: 276 }));
    writeFileSync(join(spool, 'b-eth.pcap'), pcapFile([[1700000000, 0, rec(q, { link: 'eth' })]], { network: 1 }));
    writeFileSync(join(spool, 'c-v6nano.pcap'), pcapFile([[1700000000, 700_000_000, rec(q, { v6: true })]], { nano: true }));
    writeFileSync(join(spool, 'd-le.pcap'), pcapFile([[1700000000, 0, rec(q)]], { endian: 'LE' }));
    writeFileSync(join(spool, 'e-garbage.pcap'), Buffer.from('not a pcap file at all'));
    // 短记录（incl=10 短于 SLL 头）后随合法记录：跳过且前进，合法记录照采（阶段门 B P6）
    writeFileSync(join(spool, 'g-short.pcap'), pcapFile([[1700000000, 0, Buffer.alloc(10)], [1700000001, 0, rec(q)]]));
    // 截断记录：尾部半包——本轮不消费，补全后下轮补读
    const full = pcapFile([[1700000000, 0, rec(q)]]);
    writeFileSync(join(spool, 'f-torn.pcap'), Buffer.concat([full.subarray(0, full.length - 10)]));
    const r = runConverter(home, dnsRoot);
    assert.equal(r.status, 0);
    const lines = readSamples(home);
    assert.equal(lines.length, 5, `四变体+短记录文件各贡献（垃圾与截断不产——收到 ${lines.length}）`);
    const torn = JSON.parse(readFileSync(join(home, 'dns', 'cursor.json'), 'utf8')).files['f-torn.pcap'];
    assert.ok(torn < readFileSync(join(spool, 'f-torn.pcap')).length, '截断记录游标停在完整边界');
    writeFileSync(join(spool, 'f-torn.pcap'), full);
    runConverter(home, dnsRoot);
    assert.equal(readSamples(home).length, 6, '补全后下轮补读');
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(dnsRoot, { recursive: true, force: true }); }
});

test('collect-linux-dns：fail-open——spool 缺失静默退 0', () => {
  const home = tmpHome('os-observe-dns-');
  const dnsRoot = mkdtempSync(join(tmpdir(), 'os-observe-dnsroot-')); // 空载体目录（无 dns-spool 子目录）
  try {
    const r = runConverter(home, dnsRoot);
    assert.equal(r.status, 0);
    assert.equal(existsSync(join(home, 'raw')), false);
  } finally { rmSync(home, { recursive: true, force: true }); rmSync(dnsRoot, { recursive: true, force: true }); }
});

// ── 启用链（内部验收-17：注入缝桩；sudo 交互与真机链归人工实测口径）──

function fakeTcpdumpBin(dir) {
  const p = join(dir, 'tcpdump-bin');
  writeFileSync(p, Buffer.from('stub-tcpdump-binary'));
  return p;
}

test('dnsGuide：四要素齐备（含不代装与发行版命令）', () => {
  const g = dnsGuide();
  assert.equal(g.ok, true);
  for (const k of ['source', 'version', 'verification', 'policy']) {
    assert.ok(typeof g.elements[k] === 'string' && g.elements[k].length > 0, `要素 ${k} 非空`);
  }
  assert.ok(g.elements.source.includes('不代装'));
  for (const cmd of ['apt install tcpdump', 'dnf install tcpdump', 'pacman -S tcpdump', 'zypper install tcpdump']) {
    assert.ok(g.elements.source.includes(cmd), `来源须含 ${cmd}`);
  }
  assert.ok(g.elements.policy.includes('未核验不启用'));
  assert.equal(g.steps.length, 5);
  assert.ok(g.steps.join('\n').includes('dns-enable'));
  assert.ok(g.steps.join('\n').includes('status'));
});

test('dnsPrepare：成功记账（rpm-clean）/包脏拒/tcpdump 缺席 needInstall/非 linux unavailable', () => {
  const home = tmpHome('os-observe-dns-');
  const restoreEnv = enterEnv({ OS_OBSERVE_HOME: home });
  const bin = fakeTcpdumpBin(home);
  const sha = createHash('sha256').update(readFileSync(bin)).digest('hex');
  const base = dnsBaseSpawn(bin);
  const baseSpawn = (cmd, args) => base(cmd, args) ?? { status: 0, stdout: '', stderr: '' };
  try {
    const r = dnsPrepare({ spawnFn: baseSpawn, platform: 'linux', now: Date.parse('2026-09-20T08:00:00Z') });
    assert.equal(r.ok, true, `记账须成功（收到 ${JSON.stringify(r)}）`);
    const p = JSON.parse(readFileSync(join(home, 'dns', 'provenance.json'), 'utf8'));
    assert.equal(p.schemaVersion, 1);
    assert.equal(p.tool, 'tcpdump');
    assert.equal(p.version, '4.99.1');
    assert.equal(p.binaryPath, bin);
    assert.equal(p.sha256Tcpdump, sha);
    assert.equal(p.packageCheck, 'rpm-clean');
    assert.equal(p.verifiedAt, '2026-09-20T08:00:00.000Z');
    // 包脏（dpkg -V 有输出）→ 拒、无 provenance
    const home2 = tmpHome('os-observe-dns-');
    process.env.OS_OBSERVE_HOME = home2;
    const bin2 = fakeTcpdumpBin(home2);
    // rpm 空臂显式覆盖＝保原 dirty 无 rpm 分支语义（-ql 恒空清单）
    const dirtyBase = dnsBaseSpawn(bin2, { dpkg: { status: 0, stdout: '??5 /usr/sbin/tcpdump\n', stderr: '' }, rpm: () => ({ status: 0, stdout: '', stderr: '' }) });
    const dirty = (cmd, args) => dirtyBase(cmd, args) ?? { status: 0, stdout: '', stderr: '' };
    const d = dnsPrepare({ spawnFn: dirty, platform: 'linux' });
    assert.equal(d.ok, false);
    assert.ok(String(d.error).includes('包完整性校验未过'));
    assert.equal(existsSync(join(home2, 'dns', 'provenance.json')), false, '未核验不落账');
    rmSync(home2, { recursive: true, force: true });
    // rpm 语义：差异退 1 且 stdout 有输出 → 同样拒（阶段门 B P3：原实现只查 status===0）
    const home4 = tmpHome('os-observe-dns-');
    process.env.OS_OBSERVE_HOME = home4;
    const bin4 = fakeTcpdumpBin(home4);
    const rpmDirtyBase = dnsBaseSpawn(bin4, { rpm: () => ({ status: 1, stdout: 'S.5....T.  /usr/sbin/tcpdump\n', stderr: '' }) });
    const rpmDirty = (cmd, args) => rpmDirtyBase(cmd, args) ?? { status: 0, stdout: '', stderr: '' };
    const rd = dnsPrepare({ spawnFn: rpmDirty, platform: 'linux' });
    assert.equal(rd.ok, false, 'rpm -V 退 1 有输出须拒');
    assert.ok(String(rd.error).includes('包完整性校验未过'));
    assert.equal(existsSync(join(home4, 'dns', 'provenance.json')), false);
    rmSync(home4, { recursive: true, force: true });
    // 在册绑定拒（H10 半面，阶段门 A 发现 1，内部任务-281）：rpm -V 干净但 -ql 清单不含解析路径
    // （PATH 前置植入形态）→ 拒、无 provenance——原判据（sha256 自洽＋包库副本校验）对此盲
    const home5 = tmpHome('os-observe-dns-');
    process.env.OS_OBSERVE_HOME = home5;
    const bin5 = fakeTcpdumpBin(home5);
    const nrBase = dnsBaseSpawn(bin5, { rpmList: '/usr/sbin/tcpdump\n' });
    const notRegistered = (cmd, args) => nrBase(cmd, args) ?? { status: 0, stdout: '', stderr: '' };
    const nr = dnsPrepare({ spawnFn: notRegistered, platform: 'linux' });
    assert.equal(nr.ok, false, '解析路径不在册清单须拒（伪品会被烘进 root 载体）');
    assert.ok(String(nr.error).includes('在册清单'), String(nr.error));
    assert.equal(existsSync(join(home5, 'dns', 'provenance.json')), false);
    rmSync(home5, { recursive: true, force: true });
    // tcpdump 缺席 → needInstall 引导
    const home3 = tmpHome('os-observe-dns-');
    process.env.OS_OBSERVE_HOME = home3;
    const absent = (cmd) => (cmd === 'tcpdump' ? { error: { code: 'ENOENT' }, status: null } : { status: 0, stdout: '', stderr: '' });
    const a = dnsPrepare({ spawnFn: absent, platform: 'linux' });
    assert.equal(a.ok, false);
    assert.equal(a.needInstall, true);
    assert.ok(String(a.error).includes('不代装'));
    assert.equal(existsSync(join(home3, 'dns')), false);
    rmSync(home3, { recursive: true, force: true });
    // 非 linux → unavailable
    assert.equal(dnsPrepare({ spawnFn: baseSpawn, platform: 'win32' }).availability, 'unavailable');
  } finally {
    restoreEnv();
    rmSync(home, { recursive: true, force: true });
  }
});

test('dnsEnable(uid=0)：部署+双 crontab 写入复核（%%s 转义/引号形态）；复核未过 → ok:false', { skip: POSIX_FS_SKIP }, () => {
  const home = tmpHome('os-observe-dns-');
  const dnsRoot = newDnsRoot();
  const restoreEnv = enterEnv({ OS_OBSERVE_HOME: home, OS_OBSERVE_DNS_ROOT: dnsRoot });
  // 预置限制性权限 spool（阶段门 A 发现 3：mkdir 在 umask 022 下缺省即 0755，无此预置则
  // spool 显式 chmod 断言零证伪力——0700 预置后只有实现侧 chmodSync 能收敛到 0755）
  mkdirSync(join(dnsRoot, 'dns-spool'), { recursive: true });
  chmodSync(join(dnsRoot, 'dns-spool'), 0o700);
  const bin = fakeTcpdumpBin(home);
  // 旧载体预置（H10 迁移清理面）：先建目录后写文件（反序 ENOENT——round1 E2）
  mkdirSync(join(home, 'bin'), { recursive: true });
  writeFileSync(join(home, 'bin', 'dns-keepalive.sh'), 'legacy-keepalive-stub');
  const tables = { root: '', user: '0 0 * * * echo hi\n' };
  const calls = [];
  const base = dnsBaseSpawn(bin);
  const spawnFn = (cmd, args, opts) => {
    calls.push([cmd, args]);
    const isRoot = cmd === 'sudo';
    const face = isRoot ? 'root' : 'user'; // uid=0 → 全部直跑（无 sudo）；用户面与 root 面同壳区分：
    const b = base(cmd, args);
    if (b !== undefined) return b;
    if (cmd === 'pgrep' || cmd === 'pkill') return { status: 1, stdout: '', stderr: '' };
    if (args[0] === '-l') return { status: tables[face] ? 0 : 1, stdout: tables[face], stderr: '' };
    if (args[0] === '-') { tables[face] = String(opts?.input ?? ''); return { status: 0, stdout: '', stderr: '' }; }
    return { status: 0, stdout: '', stderr: '' };
  };
  try {
    const r = dnsEnable({ spawnFn, platform: 'linux', uid: 0, nodePath: '/n/node', pollMinutes: 5 });
    assert.equal(r.ok, true, `enable 须成功（收到 ${JSON.stringify(r)}）`);
    assert.ok(existsSync(join(home, 'bin', 'collect-linux-dns.mjs')), '转换器已部署');
    // uid=0：root 面与用户面同表——单次合并双块写（防两次 read-filter-write 互相覆盖）
    assert.ok(tables.user.includes(DNS_ROOT_MARKER), '同表含保活 marker');
    assert.ok(!tables.user.includes('pgrep'), '保活不含 pgrep（sh -c 整行自匹配短路已结构性消除）');
    assert.ok(tables.user.includes(`'${join(dnsRoot, 'keepalive.sh')}'`), '保活行调 root 属主载体（H10 迁移，内部任务-281）');
    const cronKeepalive = tables.user.split('\n').find((l) => l.includes('keepalive.sh'));
    assert.ok(!cronKeepalive.includes('%'), 'cron 行零 % 字符（本机 crond 不支持 %% 转义——真机实测捕获，%s 只存脚本内）');
    // 部署脚本体承载保活语义：flock 单实例 + 记账绝对路径 + -Z root + strftime %s（载体=root 属主目录）
    const script = readFileSync(join(dnsRoot, 'keepalive.sh'), 'utf8');
    assert.ok(script.includes('flock -n'));
    assert.ok(script.includes(`'${bin}' -Z root -i any`), 'tcpdump 记账绝对路径+禁写盘降权（0700 home 真机实测）');
    assert.ok(script.includes(`-w '${join(dnsRoot, 'dns-spool')}/dns-%s.pcap'`), 'pcap 轮转（strftime %s 单写脚本内；spool=root 属主载体目录）');
    // 旧 pcap 裁剪（内部未决-36 实证 2026-09-21：tcpdump 4.99.1 的 -W 与 -G 联用=创建满 N 个
    // 轮转文件即 exit 0、重启进程不计数旧文件——cron 每 5 分钟重拉后旧 pcap 无界累积；
    // 子串断言不依赖 shQuote——本文件未导入它，且 shQuote 恒单引号、目录引号内不带 glob）
    assert.ok(script.includes('tail -n +25') && script.includes(`xargs -r -d '\\n' rm -f --`),
      'keepalive 拉起前裁剪：保最新 24 个（-W 24 同窗）+ 按整行切分（空格路径防分词静默空转）');
    assert.ok(script.includes('/dns-*.pcap 2>/dev/null'),
      '裁剪锚定 dns-*.pcap 且目录引号内不带 glob（引号内不展开）');
    assert.ok(script.includes('-W 24'), '轮转窗 -W 24 与裁剪窗 tail -n +25 同宽配对在册（ROTATE_KEEP 同源）');
    assert.ok(script.includes('内部未决-36'), '生成脚本内实证注记在场');
    // H10 载体属主面（内部任务-281）：uid=0 直写＋显式 chmod——目录与脚本三方一致 0755（round1 E1）
    assert.equal(statSync(join(dnsRoot, 'keepalive.sh')).mode & 0o777, 0o755, 'root 载体脚本 0755（显式 chmod 防御 umask）');
    assert.equal(statSync(join(dnsRoot, 'dns-spool')).mode & 0o777, 0o755, 'spool 目录 0755（用户只读——转换器非提权消费）');
    assert.equal(statSync(dnsRoot).mode & 0o777, 0o755, '载体根目录 0755');
    assert.equal(existsSync(join(home, 'bin', 'dns-keepalive.sh')), false, '家目录旧 keepalive 已清理（H10 迁移）');
    assert.ok(tables.user.includes(DNS_USER_MARKER), '同表含转换 marker');
    assert.ok(tables.user.includes(`*/5 * * * * '/n/node' `), '用户行轮询（引号形态）');
    assert.ok(tables.user.includes(`'${join(home, 'bin', 'collect-linux-dns.mjs')}'`), '用户行指向部署面');
    assert.ok(tables.user.includes('echo hi'), '既有用户行保留');
    assert.equal(tables.root, '', 'uid=0 无 sudo 面');
    assert.ok(!calls.some(([c]) => c === 'sudo'), 'uid=0 零 sudo 调用');
    // pollMinutes 因子集校验（阶段门 B P5：非法值产生静默死 cron 行）
    assert.equal(dnsEnable({ spawnFn, platform: 'linux', uid: 0, nodePath: '/n/node', pollMinutes: 90 }).usage, true, '90 非因子须 usage 拒');
    // 复核未过（回读永不出现 marker）→ ok:false——uid=0 载体经直接 fs 写入（不经桩），bad 桩下
    // carrierOk 实为 true，负例经 userOk=false（crontab 回读无标记锚）触发（round1 E6① 因果按实）
    tables.root = '';
    tables.user = '0 0 * * * echo hi\n';
    const bad = (cmd, args) => base(cmd, args) ?? { status: 0, stdout: '', stderr: '' }; // -l 恒空
    const b = dnsEnable({ spawnFn: bad, platform: 'linux', uid: 0, nodePath: '/n/node' });
    assert.equal(b.ok, false);
    assert.ok(String(b.error).includes('复核'));
  } finally {
    restoreEnv();
    rmSync(home, { recursive: true, force: true });
    rmSync(dnsRoot, { recursive: true, force: true });
  }
});

test('dnsEnable(uid=1000)：sudo -v 先行+root 面 sudo -n；sudo 失败即拒', { skip: POSIX_FS_SKIP }, () => {
  const home = tmpHome('os-observe-dns-');
  const dnsRoot = newDnsRoot();
  const restoreEnv = enterEnv({ OS_OBSERVE_HOME: home, OS_OBSERVE_DNS_ROOT: dnsRoot });
  const bin = fakeTcpdumpBin(home);
  const tables = { root: '', user: '' };
  const calls = [];
  const base = dnsBaseSpawn(bin);
  const spawnFn = (cmd, args, opts) => {
    calls.push([cmd, args]);
    if (cmd === 'sudo' && args[0] === '-v') return { status: 0, stdout: '', stderr: '' };
    const b = base(cmd, args);
    if (b !== undefined) return b;
    // H10 部署面仿真（内部任务-281）：sudo mkdir/chmod/tee 落真实 tmp——uid=1000 分支经 sudo 建 root 载体
    if (cmd === 'sudo' && args[0] === '-n' && args[1] === 'mkdir') { mkdirSync(args[3], { recursive: true }); mkdirSync(args[4], { recursive: true }); return { status: 0, stdout: '', stderr: '' }; }
    if (cmd === 'sudo' && args[0] === '-n' && args[1] === 'chmod') { const i = args.indexOf('755'); for (const t of args.slice(i + 1)) chmodSync(t, 0o755); return { status: 0, stdout: '', stderr: '' }; }
    if (cmd === 'sudo' && args[0] === '-n' && args[1] === 'tee') { writeFileSync(args[2], String(opts?.input ?? ''), 'utf8'); return { status: 0, stdout: '', stderr: '' }; }
    const face = cmd === 'sudo' ? 'root' : 'user';
    const tail = args[args.length - 1]; // sudo 包装后 -l/- 在末位
    if (tail === '-l') return { status: tables[face] ? 0 : 1, stdout: tables[face], stderr: '' };
    if (tail === '-') { tables[face] = String(opts?.input ?? ''); return { status: 0, stdout: '', stderr: '' }; }
    return { status: 0, stdout: '', stderr: '' };
  };
  try {
    const r = dnsEnable({ spawnFn, platform: 'linux', uid: 1000, nodePath: '/n/node' });
    assert.equal(r.ok, true);
    const sudoV = calls.findIndex(([c, a]) => c === 'sudo' && a[0] === '-v');
    const sudoCron = calls.findIndex(([c, a]) => c === 'sudo' && a[1] === 'crontab');
    assert.ok(sudoV >= 0, '须有 sudo -v（凭据缓存）');
    assert.ok(sudoCron > sudoV, 'sudo -v 先于 root 面 sudo -n crontab');
    assert.ok(calls.some(([c, a]) => c === 'sudo' && a[0] === '-n' && a[1] === 'crontab'), 'root 面经 sudo -n crontab');
    // H10 部署链（内部任务-281）：keepalive 经 sudo tee 落 root 载体（tee 建物恒 root 属主）＋chmod 0755
    assert.ok(calls.some(([c, a]) => c === 'sudo' && a[0] === '-n' && a[1] === 'tee' && a[2] === join(dnsRoot, 'keepalive.sh')), 'keepalive 经 sudo tee 部署到 root 载体');
    assert.equal(statSync(join(dnsRoot, 'keepalive.sh')).mode & 0o777, 0o755, '载体脚本 0755（sudo chmod 已仿真）');
    const deny = (cmd, args) => (cmd === 'sudo' && args[0] === '-v'
      ? { status: 1, stderr: 'denied' }
      : base(cmd, args)) ?? { status: 0, stdout: '', stderr: '' };
    const d = dnsEnable({ spawnFn: deny, platform: 'linux', uid: 1000, nodePath: '/n/node' });
    assert.equal(d.ok, false);
    assert.ok(String(d.error).includes('sudo'));
  } finally {
    restoreEnv();
    rmSync(home, { recursive: true, force: true });
    rmSync(dnsRoot, { recursive: true, force: true });
  }
});

test('dnsDisable：双面标记块移除（保留无关行）+ pkill 幂等；dnsStatus fail-open 形态', () => {
  const home = tmpHome('os-observe-dns-');
  const dnsRoot = newDnsRoot();
  const restoreEnv = enterEnv({ OS_OBSERVE_HOME: home, OS_OBSERVE_DNS_ROOT: dnsRoot });
  const bin = fakeTcpdumpBin(home);
  // 旧载体预置（H10 迁移清理面）：disable 后必须消失（已无 cron 引用）
  mkdirSync(join(home, 'bin'), { recursive: true });
  writeFileSync(join(home, 'bin', 'dns-keepalive.sh'), 'legacy-keepalive-stub');
  const tables = {
    root: '',
    // uid=0：root 面与用户面同表（单 crontab）——两标记块同置 user 面（真实 root 机器形态）；
    // 保活命令行持新代 spool 字面值（H10 迁移后形态——disable 的双 pkill 以此为靶）
    user: `0 0 * * * echo user-job\n${DNS_ROOT_MARKER}\n*/5 * * * * pgrep -f '${join(dnsRoot, 'dns-spool')}/dns-' || tcpdump -w ${join(dnsRoot, 'dns-spool')}/dns-%%s.pcap\n${DNS_USER_MARKER}\n*/5 * * * * /n/node ${join(home, 'bin', 'collect-linux-dns.mjs')}\n`,
  };
  const pkCalls = [];
  const spawnFn = (cmd, args, opts) => {
    if (cmd === 'pkill') { pkCalls.push(args.join(' ')); return { status: 1, stdout: '', stderr: '' }; } // 无实例——幂等
    const face = cmd === 'sudo' ? 'root' : 'user';
    if (args[0] === '-l') return { status: 0, stdout: tables[face], stderr: '' };
    if (args[0] === '-') { tables[face] = String(opts?.input ?? ''); return { status: 0, stdout: '', stderr: '' }; }
    if (cmd === 'pgrep') return { status: 1, stdout: '', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  try {
    const r = dnsDisable({ spawnFn, platform: 'linux', uid: 0 });
    assert.equal(r.ok, true);
    assert.ok(tables.user.includes('echo user-job'), '无关用户行保留');
    assert.ok(!tables.user.includes(DNS_ROOT_MARKER), '保活标记块移除（uid=0 同表）');
    assert.ok(!tables.user.includes('tcpdump -w'), '保活命令行移除');
    assert.ok(!tables.user.includes(DNS_USER_MARKER), '转换标记块移除');
    assert.ok(!tables.user.includes('collect-linux-dns.mjs'), '转换命令行移除');
    assert.ok(String(r.note).includes('不销账'));
    assert.ok(pkCalls.some((a) => a.includes(join(dnsRoot, 'dns-spool'))), 'pkill 覆盖新代 spool 模式（root 属主载体）');
    assert.ok(pkCalls.some((a) => a.includes(join(home, 'dns-spool'))), 'pkill 覆盖旧代家目录 spool 模式（H10 迁移兼容扫——阶段门 A 发现 2 证伪力补强）');
    assert.equal(existsSync(join(home, 'bin', 'dns-keepalive.sh')), false, '家目录旧 keepalive 已清理（H10 迁移清理面）');
    assert.equal(dnsDisable({ spawnFn, platform: 'linux', uid: 0 }).ok, true, '二次停用幂等');
    assert.equal(dnsDisable({ spawnFn, platform: 'win32', uid: 0 }).availability, 'unavailable');
    // 非 root 且 sudo 凭据不可用 → 失败可见（root 条目留存不得假成功，阶段门 B P2）
    const denySudo = (cmd, args) => {
      if (cmd === 'sudo' && args[0] === '-v') return { status: 1, stderr: 'denied' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const dn = dnsDisable({ spawnFn: denySudo, platform: 'linux', uid: 1000 });
    assert.equal(dn.ok, false, 'sudo 不可用须 ok:false');
    assert.ok(String(dn.error).includes('sudo'));
    assert.ok(String(dn.error).includes('勿视作已停'), 'note 须明示 root 条目仍在');
    // pkill 非 0/1 退出 → 失败可见
    const pkFail = (cmd, args) => {
      if (cmd === 'pkill') return { status: 2, stdout: '', stderr: 'syntax' };
      if (args[0] === '-l') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const pf = dnsDisable({ spawnFn: pkFail, platform: 'linux', uid: 0 });
    assert.equal(pf.ok, false, 'pkill 异常退出须 ok:false');
    assert.ok(String(pf.error).includes('pkill'));
    // pkill 不可执行（spawn 失败归 null）→ 失败可见，不静默假成功（收尾评审正确性 1）
    const pkNull = (cmd, args) => {
      if (cmd === 'pkill') return { error: { code: 'ENOENT' }, status: null };
      if (args[0] === '-l') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const pn = dnsDisable({ spawnFn: pkNull, platform: 'linux', uid: 0 });
    assert.equal(pn.ok, false, 'pkill 缺席须 ok:false');
    assert.ok(String(pn.error).includes('不可执行'));
    // sudo 包装下 pkill 缺席（sudo 退 1 + stderr not found）→ 与「无实例」同码位不同因，须失败可见
    const sudoPk = (cmd, args) => {
      if (cmd === 'sudo' && args[1] === 'pkill') return { status: 1, stdout: '', stderr: 'sudo: pkill: command not found' };
      if (cmd === 'sudo' && args[0] === '-v') return { status: 0, stdout: '', stderr: '' };
      if (args[0] === '-l' || args[args.length - 1] === '-l') return { status: 0, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const sp = dnsDisable({ spawnFn: sudoPk, platform: 'linux', uid: 1000 });
    assert.equal(sp.ok, false, 'sudo 包装 pkill 缺席须 ok:false（非幂等分支）');
    // status：默认 fail-open 形态
    const s = dnsStatus({ spawnFn, platform: 'linux', uid: 0 });
    assert.equal(s.ok, true);
    assert.equal(s.platform, true);
    assert.equal(s.process, false);
    assert.equal(s.rootCron, false);
    assert.equal(s.userCron, false);
    assert.equal(s.provenance, null);
    assert.deepEqual(s.spool, { files: 0, newestTsMs: 0 });
    // status：进程在跑 + provenance 对拍（fixture 二进制实算）
    mkdirSync(join(home, 'dns'), { recursive: true });
    const sha = createHash('sha256').update(readFileSync(bin)).digest('hex');
    writeFileSync(join(home, 'dns', 'provenance.json'), `${JSON.stringify({ schemaVersion: 1, tool: 'tcpdump', version: '4.99.1', binaryPath: bin, sha256Tcpdump: sha.toUpperCase(), packageCheck: 'rpm-clean', verifiedAt: '2026-09-20T08:00:00.000Z' })}\n`);
    mkdirSync(join(dnsRoot, 'dns-spool'), { recursive: true });
    writeFileSync(join(dnsRoot, 'dns-spool', 'dns-x.pcap'), Buffer.from('pc'));
    tables.user = `${DNS_ROOT_MARKER}\n*/5 * * * * keepalive\n${DNS_USER_MARKER}\n*/5 * * * * convert\n`;
    const alive = (cmd, args) => (cmd === 'pgrep' ? { status: 0, stdout: '999\n', stderr: '' } : spawnFn(cmd, args));
    const s2 = dnsStatus({ spawnFn: alive, platform: 'linux', uid: 0 });
    assert.equal(s2.process, true);
    assert.equal(s2.rootCron, true, 'uid=0 同表：rootCron 经用户面读取命中');
    assert.equal(s2.userCron, true);
    assert.equal(s2.provenanceMatch, true, '记账大写哈希与实算小写对拍（归一）');
    assert.equal(s2.spool.files, 1);
    assert.ok(s2.spool.newestTsMs > 0);
  } finally {
    restoreEnv();
    rmSync(home, { recursive: true, force: true });
    rmSync(dnsRoot, { recursive: true, force: true });
  }
});
