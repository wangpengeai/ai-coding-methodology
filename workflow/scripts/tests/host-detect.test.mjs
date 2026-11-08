// 文件：host-detect.test.mjs
// 描述：host-detect.mjs 单源宿主探测的行为测试（内部规则-13 / 内部决策-063 修正案 3 决策 19）——
//       显式 meta.host 优先、四前缀各命中、**表序优先级**（ZCODE_ 末位：Kimi/MCode 的 hook
//       shim 会向被 spawn 的钩子注入 ZCODE_PLUGIN_ROOT/ZCODE_PROJECT_DIR，排前面会把
//       DSH/Kimi/MCode 误判成 zcode）、空值忽略、未知→unknown、注入 env 不污染 process.env。
// 作者：wangp  创建：2026-10-24  版权：MIT（见 workflow/LICENSE）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { HOST_ENV_PREFIXES, hostOf } from '../lib/host-detect.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, '..', 'lib', 'host-detect.mjs');

test('host-detect：前缀表序与 ZCODE_ 末位（单源数据面）', () => {
  assert.deepEqual(
    HOST_ENV_PREFIXES.map(([token, prefix]) => [token, prefix]),
    [
      ['dsh', 'DSH_'],
      ['kimi', 'KIMI_'],
      ['mcode', 'MCODE_'],
      ['zcode', 'ZCODE_'],
    ],
    '表序即优先级，ZCODE_ 必须末位（Kimi/MCode shim 恒注入 ZCODE_*）',
  );
  assert.ok(Object.isFrozen(HOST_ENV_PREFIXES), '前缀表冻结（防消费方就地改序）');
});

test('host-detect：显式 meta.host 优先且短路环境探测', () => {
  assert.equal(hostOf({ host: 'custom' }, { DSH_X: '1' }), 'custom', '显式 host 优先于任何 env 前缀');
  assert.equal(hostOf({ host: 'zcode' }, { DSH_X: '1' }), 'zcode', '显式值即使与探测相反也照用（审计字段以显式为准）');
  assert.equal(hostOf({ host: '' }, { KIMI_X: '1' }), 'kimi', '空串显式值＝未声明，回落环境探测');
  assert.equal(hostOf({ host: 42 }, { MCODE_X: '1' }), 'mcode', '非字符串显式值不作数');
});

test('host-detect：四前缀各命中（单前缀矩阵）', () => {
  assert.equal(hostOf({}, { DSH_SESSION_ID: 's' }), 'dsh');
  assert.equal(hostOf({}, { KIMI_CODE_HOME: '/k' }), 'kimi');
  assert.equal(hostOf({}, { MCODE_PLUGIN_ROOT: '/m' }), 'mcode');
  assert.equal(hostOf({}, { ZCODE_PLUGIN_ROOT: '/z' }), 'zcode');
  assert.equal(hostOf({}, { PATH: '/bin', HOME: '/h' }), 'unknown', '无本仓前缀 ⇒ unknown');
});

test('host-detect：组合优先级（真实 shim 环境形态）', () => {
  // Kimi/MCode 的 hook shim 向被 spawn 钩子注入 ZCODE_PLUGIN_ROOT/ZCODE_PROJECT_DIR ——
  // 这两个组合是生产真实形态，误判即把租约审计/就绪面宿主维整体染成 zcode。
  assert.equal(hostOf({}, { DSH_SESSION_ID: 's', ZCODE_PLUGIN_ROOT: '/z' }), 'dsh', 'DSH_+ZCODE_ ⇒ dsh');
  assert.equal(hostOf({}, { KIMI_CODE_HOME: '/k', ZCODE_PLUGIN_ROOT: '/z' }), 'kimi', 'KIMI_+ZCODE_ ⇒ kimi（ZCODE_ 不得前置）');
  assert.equal(hostOf({}, { MCODE_PLUGIN_ROOT: '/m', ZCODE_PLUGIN_ROOT: '/z' }), 'mcode', 'MCODE_+ZCODE_ ⇒ mcode');
  assert.equal(hostOf({}, { DSH_X: '1', KIMI_X: '1', MCODE_X: '1', ZCODE_X: '1' }), 'dsh', '四前缀共存取表序先命中');
});

test('host-detect：空值忽略且注入 env 不污染 process.env', () => {
  assert.equal(hostOf({}, { DSH_SESSION_ID: '', KIMI_CODE_HOME: '' }), 'unknown', '空串值视同未设置（与 DEV-31 口径同源）');
  assert.equal(hostOf({}, { DSH_SESSION_ID: 's', KIMI_CODE_HOME: '' }), 'dsh', '空值不挡住后续前缀');
  const injected = { HOSTDETECT_PROBE_XYZ: '1' };
  assert.equal(hostOf({}, injected), 'unknown');
  assert.ok(!Object.hasOwn(process.env, 'HOSTDETECT_PROBE_XYZ'), '注入 env 仅作入参，不写 process.env');
});

test('host-detect：单源纪律（表与函数都在 lib，钩只消费）', () => {
  const text = readFileSync(LIB, 'utf8');
  assert.match(text, /export function hostOf/, '函数定义在 lib');
  assert.match(text, /export const HOST_ENV_PREFIXES/, '前缀表定义在 lib');
  assert.ok(text.includes('ZCODE_'), 'ZCode 前缀在表内（末位由表序用例锁）');
  // 钩侧不得再留第二张探测表：task-lease-lib/session-start 均改为引用单源。
  const gate = readFileSync(resolve(HERE, '..', '..', 'hooks', 'task-lease-lib.mjs'), 'utf8');
  const sstart = readFileSync(resolve(HERE, '..', '..', 'hooks', 'session-start.mjs'), 'utf8');
  assert.ok(!/function hostOf\s*\(/.test(gate), 'task-lease-lib 不得保留本地 hostOf 实现');
  assert.ok(!/HOST_ENV_PREFIXES\s*=/.test(sstart), 'session-start 不得保留第二张前缀表');
  assert.ok(!/function hostTokenOf\s*\(/.test(sstart), 'session-start 不得保留 hostTokenOf 实现');
});
