// 文件：dns-fixtures.mjs
// 描述：team-governance os-observe dns 测试域件（内部任务-337 内部未决-252②③ 收敛）——dns 载体根夹具与
//       rpm/dpkg 桩基座工厂；域键知识（OS_OBSERVE_DNS_ROOT/tcpdump 版本行）不进通用 helpers.mjs。
// 作者：wangp 创建：2026-11-06 版权：MIT（见 team-governance/LICENSE）
// 纪律：仅 node: 内置模块（内部非功能需求-1）。
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** dns 载体根夹具（内部未决-252③）：mkdtemp 前缀与既有用例逐字一致。 */
export function newDnsRoot() {
  return mkdtempSync(join(tmpdir(), 'os-observe-dnsroot-'));
}

/**
 * rpm/dpkg 桩基座工厂（内部未决-252②）：tcpdump 4.99.1 / which / rpm（-V 干净＋-ql 在册清单含解析路径）/
 * dpkg ENOENT 四行恒同组合；未命中命令返回 undefined 交调用方本地分支续判（fallthrough 保序——
 * tcpdump/which/rpm/dpkg 判别先于 pgrep/crontab 本地分支，与原 spawnFn 序一致）。
 * 变体经参数覆盖：rpm 整臂替换（rpmDirty/空清单形态）、rpmList 固定清单（notRegistered）、
 * dpkg 整臂替换（dpkg -V 脏输出）。注：tcpdump 桩统一为单版本行（原 dnsPrepare baseSpawn 的
 * libpcap 附加行仅一处存在，version 正则只消费首行——统一后断言不受影响）。
 * @param {string} bin which 返回的 tcpdump 路径
 * @param {{rpmList?: string, rpm?: Function, dpkg?: object}} [opts]
 */
export function dnsBaseSpawn(bin, { rpmList = `${bin}\n`, rpm, dpkg } = {}) {
  const rpmArm = rpm ?? ((args) => ({ status: 0, stdout: args[0] === '-ql' ? rpmList : '', stderr: '' }));
  return (cmd, args) => {
    if (cmd === 'tcpdump') return { status: 0, stdout: 'tcpdump version 4.99.1\n', stderr: '' };
    if (cmd === 'which') return { status: 0, stdout: `${bin}\n`, stderr: '' };
    if (cmd === 'rpm') return rpmArm(args);
    if (cmd === 'dpkg') return dpkg ?? { error: { code: 'ENOENT' }, status: null };
    return undefined;
  };
}
