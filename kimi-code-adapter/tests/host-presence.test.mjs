// 文件：kimi-code-adapter/tests/host-presence.test.mjs
// 描述：detectHostApp 平台注入行为测试（内部任务-233）——非 win32/darwin 机上默认平台走「无候选」
//       早退支，darwin/win32 深路径（候选展开/hit 判定）原先只在对应平台真机经 CLI 间接执行，
//       函数覆盖随执行机平台漂移；以 platform 注入缝在任意平台断言深路径行为（候选展开 ≡ 签名库
//       按 ~/→homedir 规则展开；present ≡ 存在候选），真机在位语义仍由 install/verify 与
//       内部决策-048 链承载，本测试不宣称在位性。
// 作者：wangp  创建：2026-10-26  版权：MIT（见 workflow/LICENSE）
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { detectHostApp } from '../src/host-presence.mjs';
import { REPO_ROOT } from './helpers.mjs';

const SIGNATURES = join(REPO_ROOT, 'spec-gate', 'assurance', 'host-signatures.json');

/** 期望候选展开（与实现同规则：~/ 前缀按 homedir，其余原样）。 */
function expectedCandidates(platform) {
  const signatures = JSON.parse(readFileSync(SIGNATURES, 'utf8'));
  return signatures.hosts.kimi[platform].map((entry) => (entry.startsWith('~/') ? join(homedir(), entry.slice(2)) : entry));
}

test('detectHostApp 平台注入：win32/darwin 候选展开与 hit/present 判定＋linux 空占位 fail-loud（任意平台可跑）', () => {
  for (const platform of ['win32', 'darwin']) {
    const expected = expectedCandidates(platform);
    const r = detectHostApp({}, platform);
    assert.deepEqual(r.candidates, expected, `${platform} 候选须与签名库按 ~/→homedir 展开一致`);
    const hit = expected.find((c) => existsSync(c));
    assert.equal(r.present, Boolean(hit), `${platform} present ≡ 存在任一候选`);
    assert.equal(r.hit ?? undefined, hit ?? undefined, `${platform} hit 须为首个存在候选`);
  }
  // linux：签名库空数组占位（宿主未取证，内部决策-048 fail-loud 语义）——不返回候选、不静默判 absent
  const linux = detectHostApp({}, 'linux');
  assert.equal(linux.present, false);
  assert.deepEqual(linux.candidates, []);
  assert.ok(linux.reason.includes('空占位'), `${linux.reason}（须为空占位分支文案——钉分支专属拒因，DEV-44 纪律）`);
});
