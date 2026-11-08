// 文件：research-loop/tests/prereg-template.test.mjs
// 描述：预注册卡模板契约测试——按 `## N.` 小节切分后逐字段断言（八字段小节序号/标题连续、
//       判据节含最小值得行动的差与决策规则、修订节含追加新卡与原卡判据保持原样、
//       数据接触声明节含「是否已见过」、竞争解释六类在候选假设节）。
//       内部任务-270 评审修复批：R08 小节切分替代全文 includes、R09 字段 token 口径统一。
// 作者：wangp  创建：2026-10-16  版权：MIT（见 research-loop/LICENSE）
// 修改记录：
//   v1.0.0 2026-10-16 wangp 初始创建（内部任务-109 S1 步骤 1.2）
//   v1.0.1 2026-11-01 wangp 内部任务-270：R08 八小节切分断言（SESOI/修订/数据接触/六类入节）、
//           R09 token 口径统一；文件头规范化
// 自检：node --test "research-loop/tests/prereg-template.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const TPL = join(here, '..', 'assets', 'prereg-card-template.md');

/** 八个字段小节标题（内部规则-4：冻结观察/研究问题/候选假设＋竞争解释/判别性预测/判据与最小值得行动的差/实验设计/数据接触声明/修订留痕）。 */
const SECTIONS = [
  '1. 冻结观察',
  '2. 研究问题',
  '3. 候选假设与竞争解释（必填段）',
  '4. 判别性预测汇总',
  '5. 判据与最小值得行动的差',
  '6. 实验设计',
  '7. 数据接触声明',
  '8. 修订留痕',
];

const RIVAL_CLASSES = ['真实效应', '测量噪声', '环境与版本漂移', '种子运气', '数据泄漏', '基准过拟合'];

/** 解析小节标题序列（非 `## N.` 形态的 `##` 标题不参与，保持单一事实源）。 */
function parseSectionTitles(text) {
  return [...text.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => `${m[1]}. ${m[2]}`);
}

/** 取第 n 节正文（从该节标题行末到下一个 `## ` 标题前）。 */
function sectionBody(text, n) {
  const start = new RegExp(`^## ${n}\\. .+$`, 'm').exec(text);
  assert.ok(start, `缺第 ${n} 节`);
  const from = start.index + start[0].length;
  const next = /^## /m.exec(text.slice(from));
  return text.slice(from, next ? from + next.index : text.length);
}

test('模板在场（assets 下预注册卡模板唯一，R-M19-4 单一事实源）', () => {
  assert.ok(existsSync(TPL), `缺失 ${TPL}`);
  const tmplFiles = readdirSync(join(here, '..', 'assets')).filter((f) => f.includes('prereg') || f.includes('预注册'));
  assert.deepEqual(tmplFiles, ['prereg-card-template.md'], 'assets 下预注册卡模板须唯一（插件内单一事实源）');
});

test('模板八小节齐备（八字段；竞争解释并入第 3 节）', () => {
  const t = readFileSync(TPL, 'utf8');
  assert.deepEqual(parseSectionTitles(t), SECTIONS, '八个字段小节序号/标题须逐字一致且连续');
  // 负样本自检：未编号 `##` 标题不得被当作字段小节（内存样本，不写文件）
  assert.equal(parseSectionTitles('## 未编号标题\n正文\n## 1. 冻结观察\n').length, 1, '负样本：未编号标题不参与字段序列');
});

test('判据字段含「最小值得行动的差」（B-M19-5，SESOI 工程化）', () => {
  const t = readFileSync(TPL, 'utf8');
  const sec = sectionBody(t, 5);
  assert.ok(sec.includes('最小值得行动的差'), '判据节含最小值得行动的差');
  assert.ok(sec.includes('小于此差按噪声处理'), '判据节明示噪声处理口径');
  assert.ok(sec.includes('决策规则'), '判据节含决策规则');
  // 负样本自检：删除「## 5.」标题后 sectionBody 必须失败（内存样本，不写文件）
  assert.throws(() => sectionBody(t.replace(/^## 5\..*$/m, ''), 5), /缺第 5 节/, '负样本：缺节时切片 helper 必失败');
});

test('修订语义＝追加新卡、不覆盖原判据（B-M19-6）', () => {
  const t = readFileSync(TPL, 'utf8');
  const sec = sectionBody(t, 8);
  assert.ok(sec.includes('追加新卡'), '修订节含「追加新卡」');
  assert.ok(sec.includes('原卡判据保持原样'), '修订节含「原卡判据保持原样」');
});

test('数据接触声明字段在位（HARKing 防火墙）', () => {
  const t = readFileSync(TPL, 'utf8');
  const sec = sectionBody(t, 7);
  assert.ok(sec.includes('是否已见过'), '声明含「是否已见过」（标题由小节序列断言覆盖）');
});

test('竞争解释六类枚举齐备（B-M19-8，CS 特化）', () => {
  const t = readFileSync(TPL, 'utf8');
  const sec = sectionBody(t, 3);
  for (const c of RIVAL_CLASSES) assert.ok(sec.includes(c), `候选假设节缺竞争解释类：${c}`);
  assert.ok(sec.includes('排除方式'), '候选假设节表含「排除方式」列');
});
