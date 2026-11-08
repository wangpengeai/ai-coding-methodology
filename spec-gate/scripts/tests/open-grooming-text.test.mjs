// 内部验收-19 梳理承载文本字面量断言（内部任务-36 阶段 2 步骤 2.0，内部决策-049）
// 承载面裁定（计划设计面核验节）：内部接口-8 §7.2 ＋ 内部模块-7 内部规则-18 规格文本本身即梳理流程承载。
// 断言用锚点短语（容许措辞演进），不以整句硬锁；sectionOf 切片防全文件同词凑绿。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
function sectionOf(text, heading) {
  const start = text.indexOf(heading);
  if (start === -1) return '';
  const rest = text.slice(start);
  const nl = rest.indexOf('\n#');
  return nl === -1 ? rest : rest.slice(0, nl);
}

const ifc8 = readFileSync(join(repoRoot, '内部规格'), 'utf8');
const s72 = sectionOf(ifc8, '### 7.2');
const m7 = readFileSync(join(repoRoot, '内部规格'), 'utf8');
const rm718 = m7.split('\n').find((l) => l.startsWith('| 内部规则-18 |')) || '';

test('a) 内部接口-8 §7.2 含梳理五动作词表与全量处置纪律', () => {
  for (const a of ['关闭／降级／保留／合并／归档', '批量豁免非法', '守恒算式']) {
    assert.ok(s72.includes(a), `§7.2 须含锚点「${a}」——五动作机制缺载体即回退为口头规则`);
  }
});

test('b) 内部接口-8 §7.2 含墓碑行四元组与孤儿防护', () => {
  assert.ok(s72.includes('编号／关闭日／一句话处置／指针'), '墓碑行四元组锚点缺失');
  assert.ok(s72.includes('孤儿防护') && s72.includes('禁止有损压缩'), '孤儿防护锚点缺失（唯一记录禁有损压缩）');
});

test('c) 内部接口-8 §7.2 含归档卷机制（单卷·条数阈值·suite 登记）', () => {
  assert.ok(s72.includes('内部规格') && s72.includes('条数阈值'), '归档卷与阈值触发锚点缺失');
  assert.ok(s72.includes('open-item-archive'), 'documentType 锚点缺失');
});

test('d) 内部模块-7 内部规则-18 承载 spec-gate 侧梳理流程规则', () => {
  for (const a of ['五动作', '条数阈值', '孤儿防护', '不动冻结 core']) {
    assert.ok(rm718.includes(a), `内部规则-18 须含锚点「${a}」`);
  }
});

test('e) 登记册排列约定在位（未关全文在前＋墓碑在后）', () => {
  const reg = readFileSync(join(repoRoot, '内部规格'), 'utf8');
  let firstClosed = -1;
  let lastOpen = -1;
  reg.split('\n').forEach((l, i) => {
    if (!/^\| OPEN-\d+ \|/.test(l)) return;
    const status = (l.split('|')[4] || '').trim();
    if (status === 'CLOSED' && firstClosed === -1) firstClosed = i;
    if (status === 'OPEN' || status === '部分关闭') lastOpen = i;
  });
  assert.ok(firstClosed > lastOpen, `未关全文行须全部在墓碑行之前（首墓碑行 ${firstClosed}／末未关行 ${lastOpen}）`);
});
