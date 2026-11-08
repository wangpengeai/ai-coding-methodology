// 文件：helpers.mjs
// 描述：team-governance 测试共享夹具（内部任务-257 P5-9；内部任务-337 内部未决-223 收口扩容）——tmp 根、CLI runner
//       与低阶 spawn 原语、env 注入对、/proc 替身树；显式 env/timeout 由调用方传入。
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/** 新建 tmp 根（prefix 区分用例族）。 */
export function tmpHome(prefix = 'tg-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 低阶原语：node 子进程跑脚本，返回 spawnSync 原象（encoding utf8；env 合并、timeout 显式传入）。 */
export function runNode(script, args = [], { env, timeout } = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    ...(env ? { env: { ...process.env, ...env } } : {}),
    ...(timeout ? { timeout } : {}),
  });
}

/** 子进程跑 CLI：返回 {status,json,stdout,stderr}（env/timeout 显式传入，不隐式改全局）。 */
export function runCli(cliPath, root, args = [], { env, timeout } = {}) {
  const r = runNode(cliPath, ['--project-root', root, ...args], { env, timeout });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* 非 JSON 交给断言 */ }
  return { status: r.status, json, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** env 注入/还原对（内部未决-252③ 三明治收敛）：restore() 还原旧值、旧值为 undefined 的键删除。 */
export function enterEnv(overrides) {
  const prev = Object.fromEntries(Object.keys(overrides).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  return () => {
    for (const k of Object.keys(overrides)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  };
}

/** fixture /proc 全量替身树（原 os-observe-linux.test.mjs 本地件，内部未决-223 收口）：
 *  established v4（inode 4250434）+ 监听行 + 回环行；tcp6 公网（inode 99）+ ::1；pid 4242 持 fd→socket。 */
export function makeProcTree(root) {
  mkdirSync(join(root, 'net'), { recursive: true });
  writeFileSync(join(root, 'net', 'tcp'), [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: D600A8C0:280F 057100CB:01BB 01 00000000:00000000 00:00000000 00000000  1000        0 4250434 1 0000000000000000 100 0 0 10 5',
    '   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 18977 1 0000000000000000 100 0 0 10 0',
    '   2: D600A8C0:280F 0100007F:01BB 01 00000000:00000000 00:00000000 00000000  1000        0 30011 1 0000000000000000 100 0 0 10 5',
  ].join('\n'));
  // 203.0.113.5=057100CB（小端字反转）；2001:db8::1=b80d0120 00000000 00000000 01000000（字内字节反转）；
  // v4-mapped ::ffff:203.0.113.5=00000000 00000000 ffff0000 057100cb（阶段门 A F-C2：归一为点分 v4）
  writeFileSync(join(root, 'net', 'tcp6'), [
    '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 00000000000000000000000000000000:280F B80D0120000000000000000001000000:0050 01 00000000:00000000 00:00000000 00000000  1000        0 99 1 0000000000000000 100 0 0 10 5',
    '   1: 00000000000000000000000000000000:280F 00000000000000000000000001000000:01BB 01 00000000:00000000 00:00000000 00000000  1000        0 30012 1 0000000000000000 100 0 0 10 5',
    '   2: 00000000000000000000000000000000:280F 0000000000000000FFFF0000057100CB:01BB 01 00000000:00000000 00:00000000 00000000  1000        0 30013 1 0000000000000000 100 0 0 10 5',
  ].join('\n'));
  mkdirSync(join(root, '4242', 'fd'), { recursive: true });
  writeFileSync(join(root, '4242', 'comm'), 'zcode-agent\n');
  symlinkSync('socket:[4250434]', join(root, '4242', 'fd', '0'));
  symlinkSync('socket:[777]', join(root, '4242', 'fd', '1'));
  mkdirSync(join(root, '7'), { recursive: true });
  writeFileSync(join(root, '7', 'comm'), 'kthreadd\n'); // 内核线程无 fd——不参与归因
  return root;
}

/** fixture /proc 精简替身树（原 os-observe-e2e.test.mjs 本地件；树形态与全量件不同——e2e 断言输入，勿合并）。 */
export function makeProcTreeMinimal(root) {
  mkdirSync(join(root, 'net'), { recursive: true });
  writeFileSync(join(root, 'net', 'tcp'), [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: D600A8C0:280F 057100CB:01BB 01 00000000:00000000 00:00000000 00000000  1000        0 4250434 1 0000000000000000 100 0 0 10 5',
  ].join('\n'));
  writeFileSync(join(root, 'net', 'tcp6'), '');
  mkdirSync(join(root, '4242', 'fd'), { recursive: true });
  writeFileSync(join(root, '4242', 'comm'), 'zcode-agent\n');
  symlinkSync('socket:[4250434]', join(root, '4242', 'fd', '0'));
  return root;
}
