// 文件：activation-domain.test.mjs
// 描述：激活域判定单元测试（内部决策-026 使用反馈二批）——git 仓根优先（内部决策-022 语义
//       不变）；.scout/mode.json 与 .sdd/ presence 即激活（显式 opt-in 放宽）；标记
//       祖先上溯语义；无标记非 git 目录恒 null（内部决策-022 静默语义回归锁死）。
//       键 canonical 归一（内部任务-MACKEY-1）：fixture 根取 realpath 形态与键同空间。
// 作者：wangp  创建：2026-09-17  版权：MIT（见 workflow/LICENSE）
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { activationRoot, projectKey } from '../../hooks/routing-lib.mjs';

/**
 * mkdtemp 后立即取 canonical（realpath）形态：键归一（内部任务-MACKEY-1）后
 * activationRoot/projectKey 返回 realpath 形态，期望值须同空间——macOS tmpdir
 * symlink（/var→/private/var）下 mkdtemp 原始形态与键恒不等；无 symlink 平台
 * realpathSync 幂等零变化。rmSync 用 canonical 形态删同一物理目录，无泄漏。
 * @param {string} prefix 临时目录前缀
 */
function makeRoot(prefix) {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

test('git 仓祖先：仍返回仓根（内部决策-022 语义不变）', () => {
  const root = makeRoot('act-git-');
  try {
    mkdirSync(join(root, '.git'));
    const sub = join(root, 'deep', 'deeper');
    mkdirSync(sub, { recursive: true });
    assert.equal(activationRoot(sub), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('.scout/mode.json presence：非 git 目录返回该目录（内部决策-026 放宽）', () => {
  const root = makeRoot('act-scout-');
  try {
    mkdirSync(join(root, '.scout'), { recursive: true });
    writeFileSync(join(root, '.scout', 'mode.json'), '{}\n');
    assert.equal(activationRoot(root), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('.sdd/ presence：非 git 目录返回标记祖先（子目录上溯语义）', () => {
  const root = makeRoot('act-sdd-');
  try {
    mkdirSync(join(root, '.sdd'), { recursive: true });
    const sub = join(root, 'src');
    mkdirSync(sub);
    assert.equal(activationRoot(sub), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('无标记非 git 目录：null（内部决策-022 静默语义回归锁死）', () => {
  const root = makeRoot('act-none-');
  try {
    const sub = join(root, 'sub');
    mkdirSync(sub);
    assert.equal(activationRoot(sub), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('键统一：projectKey 在标记域子目录锚标记根（与 activationRoot 同根，防持久 deny）', () => {
  const root = makeRoot('act-key-');
  try {
    mkdirSync(join(root, '.scout'), { recursive: true });
    writeFileSync(join(root, '.scout', 'mode.json'), '{}\n');
    const sub = join(root, 'src');
    mkdirSync(sub);
    assert.equal(projectKey(sub), root);
    assert.equal(activationRoot(sub), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('键统一：无标记非 git 目录 projectKey 仍回退 cwd 自身（既有语义回归）', () => {
  const root = makeRoot('act-key-');
  try {
    const sub = join(root, 'sub');
    mkdirSync(sub);
    assert.equal(projectKey(sub), sub);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('.sdd 普通文件不误激活（isDirectory 判定，评审处置）', () => {
  const root = makeRoot('act-sddfile-');
  try {
    writeFileSync(join(root, '.sdd'), 'not a directory\n');
    assert.equal(activationRoot(root), null);
    assert.equal(projectKey(root), root); // 无标记：projectKey 回退 cwd 自身
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
