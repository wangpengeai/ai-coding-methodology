// 文件：kimi-code-adapter/tests/host-root.test.mjs
// 描述：宿主根三级探测单测（`--data-dir` > `KIMI_CODE_HOME` > 平台标准位 > fail-loud 空串）——
//       内部任务-305 D1 补的独立覆盖面（此前宿主根仅由安装面间接覆盖，优先级/回退未被钉住）。
// 作者：wangp  创建：2026-11-03  版权：MIT（见仓库 LICENSE）
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { resolveHostRoot } from '../src/host-root.mjs';

describe('宿主根三级探测（DEV-305）', () => {
  it('--data-dir 优先于 env 与平台标准位', () => {
    const root = resolveHostRoot('/tmp/explicit', { KIMI_CODE_HOME: '/tmp/env', HOME: '/tmp/home', USERPROFILE: '/tmp/home' }, 'linux');
    assert.equal(root, resolve('/tmp/explicit'), '显式旗标最高优先');
  });

  it('KIMI_CODE_HOME 优先于平台标准位', () => {
    const root = resolveHostRoot('', { KIMI_CODE_HOME: '/tmp/env', HOME: '/tmp/home' }, 'linux');
    assert.equal(root, resolve('/tmp/env'), 'env 次优先');
  });

  it('平台标准位：linux/darwin 取 HOME，win32 取 USERPROFILE（回退 HOME）', () => {
    // 标准位＝用户主目录下的 .kimi-code（不是主目录本身）
    assert.equal(resolveHostRoot('', { HOME: '/tmp/home' }, 'linux'), resolve('/tmp/home', '.kimi-code'));
    assert.equal(resolveHostRoot('', { HOME: '/tmp/home' }, 'darwin'), resolve('/tmp/home', '.kimi-code'));
    assert.equal(resolveHostRoot('', { USERPROFILE: '/tmp/winhome' }, 'win32'), resolve('/tmp/winhome', '.kimi-code'));
    assert.equal(resolveHostRoot('', { HOME: '/tmp/home' }, 'win32'), resolve('/tmp/home', '.kimi-code'), 'win32 无 USERPROFILE 时回退 HOME');
  });

  it('全部来源缺失 → 空串（调用方 fail-loud，不静默猜根）', () => {
    assert.equal(resolveHostRoot('', {}, 'linux'), '');
    assert.equal(resolveHostRoot('', {}, 'darwin'), '');
    assert.equal(resolveHostRoot('', {}, 'win32'), '');
  });
});
