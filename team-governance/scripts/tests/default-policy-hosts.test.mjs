// 文件：default-policy-hosts.test.mjs
// 描述：内部任务-2 默认政策宿主集单源对拍——DEFAULT_ALLOWED_MODELS 的 provider 列必须与
//       plugin-core/capability-matrix.json 的 hosts 数组全等（第五宿主入矩阵而漏改默认
//       政策时此测试红；Node 常量/init 播种/assurance governance.mjs 镜像三处同批，见本仓 内部任务-2 计划）；
//       非仓库形态（装机树 cache/<市场>/<插件>/<版本>/）跑时守卫跳过（installed-layout 先例）。
// 作者：wangp  创建：2026-10-08  版权：MIT（见 team-governance/LICENSE）
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_ALLOWED_MODELS } from '../lib/governance-store.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MATRIX = join(REPO, 'plugin-core', 'capability-matrix.json');

if (!existsSync(MATRIX)) {
  console.log(
    `SKIP: 仓库形态守卫——capability-matrix.json 不在预期相对位（本次解析到 ${REPO}），` +
      '仅仓库形态（<repo>/<插件>/scripts/tests）可对拍；请勿从装机树运行。',
  );
  process.exit(0);
}

test('默认政策 allowedModels 与 capability-matrix hosts 单源对拍', () => {
  const hosts = JSON.parse(readFileSync(MATRIX, 'utf8')).hosts;
  assert.deepEqual(
    DEFAULT_ALLOWED_MODELS.map((m) => m.provider), hosts,
    '默认政策宿主集漂移——改 capability-matrix hosts 须同批同步 Node 常量（init 播种与归一兜底共用）与 assurance governance.mjs 镜像',
  );
  for (const m of DEFAULT_ALLOWED_MODELS) {
    assert.deepEqual(m.capabilities, ['code'], `${m.provider} 默认能力档为 ['code']`);
  }
});
