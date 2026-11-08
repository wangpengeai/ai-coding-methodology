// 文件：domain-neutrality.test.mjs
// 描述：algo-loop 域中立红线机检（内部模块-18 内部规则-10/B-M18-4）——①判别力：tmp 夹具注入领域词的伪约束行必被检出；
//       ②真资产扫描零命中 + SKILL/钩子源码无「路由表第」行号字面量。
// 作者：wangp 创建：2026-10-15 版权：MIT（见 algo-loop/LICENSE）
// 修改记录：
//   v1.1.0 2026-11-01 wangp 内部任务-269：SCAN_FILES 纳入 scripts/cli-args.mjs（新增共享参数模块同受域中立扫描）。
// 自检：node --test "algo-loop/scripts/tests/domain-neutrality.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOMAIN_TERMS = ['机器人', '导航', '规划', 'rosbag', 'ROS', 'Gazebo', 'SLAM', '成功率', '路径长度', '平滑度', '碰撞', '轮式', '实车'];
const SCAN_FILES = [
  'plugin.manifest.json',
  'hooks/session-start.mjs',
  'scripts/algo-state.mjs',
  'scripts/algo-write.mjs',
  'scripts/check-consistency.mjs',
  'scripts/cli-args.mjs',
  'templates/project.template.json',
  'templates/contract.template.json',
];

function scanText(text) {
  const hits = [];
  const lines = text.split('\n');
  lines.forEach((line, idx) => {
    if (line.includes('示例：')) return; // 示例段豁免判法：明示标记行
    for (const term of DOMAIN_TERMS) {
      if (line.includes(term)) hits.push({ line: idx + 1, term });
    }
  });
  return hits;
}

test('判别力：注入领域词的伪约束行必被检出（夹具正例）', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'algo-neutrality-'));
  try {
    writeFileSync(join(tmp, 'fake.mjs'), '// 机器人导航的路径长度统计\nconst x = 1;\n');
    const hits = scanText(readFileSync(join(tmp, 'fake.mjs'), 'utf8'));
    assert.ok(hits.length >= 2, `应至少检出「机器人」「导航」「路径长度」之一以上，实测 ${JSON.stringify(hits)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('真资产域中立扫描零命中 + SKILL/钩子源码无行号字面量（D-M18-4）', () => {
  const files = [...SCAN_FILES];
  for (const dir of ['skills']) {
    for (const d of readdirSync(join(pluginRoot, dir))) {
      if (existsSync(join(pluginRoot, dir, d, 'SKILL.md'))) files.push(`${dir}/${d}/SKILL.md`);
    }
  }
  if (existsSync(join(pluginRoot, 'README.md'))) files.push('README.md'); // 1.14 建档后自动纳入
  const allHits = [];
  for (const rel of files) {
    const hits = scanText(readFileSync(join(pluginRoot, rel), 'utf8'));
    for (const h of hits) allHits.push(`${rel}:${h.line} 命中「${h.term}」`);
  }
  assert.deepEqual(allHits, [], `域中立红线违例：\n${allHits.join('\n')}`);
  // templates 示例条目豁免判法：name 前缀 example- 的条目值不扫（上表已按「示例：」行豁免，此断言钉住模板示例形态本身合规）
  const contract = JSON.parse(readFileSync(join(pluginRoot, 'templates', 'contract.template.json'), 'utf8'));
  assert.ok(contract.metrics[0].name.startsWith('example-'), '模板示例指标须以 example- 前缀明示');
  // 行号字面量禁入新资产（以行名指代）
  for (const rel of ['skills/algo-loop/SKILL.md', 'hooks/session-start.mjs']) {
    assert.doesNotMatch(readFileSync(join(pluginRoot, rel), 'utf8'), /路由表第/, `${rel} 不嵌「路由表第 N 行」字面量`);
  }
});
