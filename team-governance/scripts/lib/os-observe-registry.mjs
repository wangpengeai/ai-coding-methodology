// 文件：os-observe-registry.mjs
// 描述：os-observation 后端注册表（内部决策-029 决策 2 载体，内部规则-9）——内置/扩展分列
//       （dependency: builtin|external-tool、requiresExplicitEnable、implemented、platforms）、
//       可用性探测（内置后端平台匹配即 available；扩展位未实现或平台不匹配一律
//       unavailable → 结果 unverified，不伪装 passed）；capability 级可用性按平台过滤
//       内置后端集（跨平台后端互不拖累，内部任务-OBSO-LINUX-1 语义修订）。未实测平台
//       不写未实测命令（内部决策-029 决策 5 / D5——Linux 经 2026-09-20 本机实测入列、darwin 经 2026-09-30 本机实测入列（内部任务-OBSO-DARWIN-1））。
// 作者：wangp  创建：2026-09-19  版权：MIT（见 team-governance/LICENSE）

export const BACKENDS = [
  {
    id: 'win-net-tcp-poll',
    dependency: 'builtin',
    requiresExplicitEnable: false,
    implemented: true,
    platforms: ['win32'],
    note: 'TCP 连接表轮询（带 OwningProcess，可归因进程；仅连接存活瞬间有效）',
  },
  {
    id: 'win-dns-cache-poll',
    dependency: 'builtin',
    requiresExplicitEnable: false,
    implemented: true,
    platforms: ['win32'],
    note: 'DNS 客户端缓存轮询（域名解析持久痕迹，无进程归因字段）',
  },
  {
    id: 'win-sysmon',
    dependency: 'external-tool',
    requiresExplicitEnable: true,
    implemented: true,
    platforms: ['win32'],
    note: 'Sysmon DnsQuery(22) 事件采样（进程归因；需显式启用：governance-cli os-observe sysmon-guide → sysmon-enable，启用链受 NFR-tg-supplychain 四要素约束，TASK-SYSMON-1/OPEN-29 落地）；采样器拒收归因为 CIM/WMI 提供程序宿主（WmiPrvSE.exe）的事件——该归因指向宿主而非调用方，且 os-observe 自身 Get-DnsClientCache（CIM）会使宿主代发缓存域名查询（采集器自观测伪影，2026-09-29 TASK-DEBTFIX-1 实证）',
  },
  {
    id: 'linux-net-tcp-poll',
    dependency: 'builtin',
    requiresExplicitEnable: false,
    implemented: true,
    platforms: ['linux'],
    note: 'TCP 连接表轮询（纯 Node 直读 /proc/net/tcp{,6}+/proc/<pid>/fd inode 进程归因；仅连接存活瞬间有效，归因限自有进程、comm 15 字符上限）',
  },
  {
    id: 'linux-dns-tcpdump',
    dependency: 'external-tool',
    requiresExplicitEnable: true,
    implemented: true,
    platforms: ['linux'],
    note: 'tcpdump pcap 轮转常驻监听 + 非提权转换器解析 DNS 问题节（进程归因恒 null、DoT/DoH 不可见；需显式启用：governance-cli os-observe dns-guide → dns-enable，启用链受 NFR-tg-supplychain 四要素约束，TASK-OBSO-LINUX-1 落地）',
  },
  {
    id: 'darwin-net-tcp-poll',
    dependency: 'builtin',
    requiresExplicitEnable: false,
    implemented: true,
    platforms: ['darwin'],
    note: 'TCP 连接表轮询（lsof -nP 单轮快照；调度载体=launchd LaunchAgent 用户域周期+SessionStart 机会式补位兜底，DEV-66；COMMAND 归因进程——限当前用户可观测面；仅连接存活瞬间有效）',
  },
];

/** 单后端可用性探测。platform 注入缝供测试；缺省取当前平台。 */
export function probeBackend(id, { platform = process.platform } = {}) {
  const b = BACKENDS.find((x) => x.id === id);
  if (!b) {
    return {
      availability: 'unavailable',
      detail: `未知后端：${id}`,
      guidance: `注册表项：${BACKENDS.map((x) => x.id).join(', ')}`,
    };
  }
  if (!b.implemented) {
    return {
      availability: 'unavailable',
      detail: `扩展位未实现（${b.note}）`,
      guidance: '开启前须完成外部工具供应链四要素核验（来源/版本/校验方式/未校验不启用，NFR-tg-supplychain），经显式引导由用户决定',
    };
  }
  if (!b.platforms.includes(platform)) {
    return {
      availability: 'unavailable',
      detail: `后端仅 ${b.platforms.join('/')} 已实测，当前平台 ${platform}`,
      guidance: '本平台无该后端已实测形态，不提供未实测指引（ADR-029 决策 5）',
    };
  }
  if (b.requiresExplicitEnable) {
    return { availability: 'available', detail: `${b.note}（在装态见 os-observe status 对应段）` };
  }
  return { availability: 'available', detail: b.note };
}

/** capability 级可用性：按平台过滤内置后端集，平台内全可用才 available（跨平台项互不拖累）。 */
export function capabilityAvailability({ platform = process.platform } = {}) {
  const builtins = BACKENDS.filter((b) => b.dependency === 'builtin' && b.implemented && b.platforms.includes(platform));
  const probes = builtins.map((b) => probeBackend(b.id, { platform }));
  if (probes.length > 0 && probes.every((p) => p.availability === 'available')) {
    return { availability: 'available', detail: `内置后端 ${builtins.map((b) => b.id).join('、')} 全部可用` };
  }
  const first = probes.find((p) => p.availability !== 'available');
  return { availability: 'unavailable', detail: first?.detail ?? '无内置后端（本平台未实测）', guidance: first?.guidance };
}
