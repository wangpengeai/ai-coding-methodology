// 文件：research-loop/tests/protocol-contract.test.mjs
// 描述：研究环五段协议契约（文本层，内部验收-9）——发散→预注册→实验设计→实验→卡追加判定＋
//       先验复审义务；顺序断言以「## 收敛半段」切片为范围（R04），SESOI skill 正文明示双断言（R08），
//       决策树要素剥 frontmatter 后断言正文（R10）。模板字段锁定归 prereg-template；真机 dogfood 转 内部未决-200。
//       内部任务-270 评审修复批：R04 切片顺序＋内存负样本、R08 SESOI 双明示、R14 去重（不再复制模板字段/
//       零状态面/hooks 断言，模板字段归 prereg-template、状态目录归 wiring）。
// 作者：wangp  创建：2026-10-25  版权：MIT（见 research-loop/LICENSE）
// 修改记录：
//   v1.0.0 2026-10-25 wangp 初始创建（内部任务-214 批 5 内部验收-9）
//   v1.0.1 2026-11-01 wangp 内部任务-270：R04 顺序断言改收敛半段切片＋负样本自检、R08 SESOI 双明示、
//           R10 决策树正文断言（剥 frontmatter）、R14 去重；版权引用修正为 research-loop/LICENSE；文件头规范化
// 自检：node --test "research-loop/tests/protocol-contract.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RL = join(REPO_ROOT, 'research-loop');
const HYP = join(RL, 'skills', 'research-hypothesis', 'SKILL.md');
const DESIGN = join(RL, 'skills', 'experiment-design', 'SKILL.md');

function read(p, what) {
  assert.ok(existsSync(p), `${what} 须在位：${p}`);
  return readFileSync(p, 'utf8');
}

/** 取从标题 h 开始到下一个 `## ` 标题前的切片（找不到标题即失败）。 */
function section(text, h) {
  const i = text.indexOf(h);
  assert.ok(i >= 0, `缺节标题：${h}`);
  const from = i + h.length;
  const n = text.indexOf('\n## ', from);
  return text.slice(from, n < 0 ? text.length : n);
}

/** 按首次出现位置断言 needles 严格递增（缺任一 needle 或乱序即红）。 */
function ordered(text, needles, label) {
  let last = -1;
  for (const n of needles) {
    const at = text.indexOf(n);
    assert.ok(at >= 0, `${label}缺锚点：${n}`);
    assert.ok(at > last, `${label}顺序错：${n}`);
    last = at;
  }
}

test('研究环五段协议契约（顺序/修订义务/决策树正文）', () => {
  const hyp = read(HYP, 'research-hypothesis SKILL');
  const design = read(DESIGN, 'experiment-design SKILL');

  // ① 两段标题存在性（五段其余锚点由 §② 切片顺序断言覆盖，避免重复弱断言）
  for (const stage of ['## 发散半段', '## 收敛半段']) {
    assert.ok(hyp.includes(stage), `研究环入口须含段标题：${stage}`);
  }
  assert.ok(hyp.indexOf('## 发散半段') < hyp.indexOf('## 收敛半段'), '发散半段须先于收敛半段');

  // ② 收敛半段内顺序（R04：切片范围内断言，避免被前置介绍句满足；helper 带内存负样本自检）
  const conv = section(hyp, '## 收敛半段');
  // 负样本自检：缺节时 section 必失败（内存样本，不写文件）
  assert.throws(() => section('## 其他\n正文', '## 收敛半段'), /缺节标题/, '负样本：缺节切片必失败');
  ordered(conv, ['预注册卡', '实验设计接', '数据接触声明', '修订＝追加新卡', '实验执行'], '收敛半段');
  assert.throws(
    () => ordered('实验执行…实验设计接…预注册卡', ['预注册卡', '实验设计接', '实验执行'], '负样本'),
    /顺序错|缺锚点/,
    '负样本自检：乱序时 ordered 必须抛错',
  );

  // ③ 先验复审义务：修订＝追加新卡、不覆盖原判据（收敛半段内逐字句）
  assert.ok(conv.includes('修订＝追加新卡，**不覆盖原判据**'), '收敛半段须含「修订＝追加新卡，不覆盖原判据」');

  // ④ SESOI 双明示（B-M19-5 的 skill 正文侧；模板侧由 prereg-template.test.mjs 锁定）
  assert.ok(hyp.includes('最小值得行动的差'), '研究环入口须明示「最小值得行动的差」');
  assert.ok(hyp.includes('小于它的差异按噪声处理'), '研究环入口须明示噪声处理口径');

  // ⑤ 实验设计决策树要素（R10：剥 frontmatter 后断言正文；「交叉」以「交叉（交替轮转）」强断言覆盖，避免重复弱断言）
  const designBody = design.replace(/^---\n[\s\S]*?\n---\n/, '');
  for (const key of ['消融', '区组', '种子', '运行序', '伪重复']) {
    assert.ok(designBody.includes(key), `实验设计 SKILL 正文须含决策树要素：${key}`);
  }
  assert.ok(designBody.includes('交叉（交替轮转）'), 'R10 正文术语须为「交叉（交替轮转）」');
});
