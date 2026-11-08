// 文件：exempt-protocol.test.mjs
// 描述：内部任务-265 豁免协议纯函数库单测（内部决策-067 D1/D2/D4/D5）——引文归一/正形、
//       声明形态、计划 marker 围栏解析、摘要分离、revoke 引文。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  EXEMPT_QUOTE_MAX,
  EXEMPT_RECORD_SCOPES,
  EXEMPT_SCOPES,
  checkExemptDeclarationShape,
  checkExemptQuoteFace,
  checkExemptRevokeQuote,
  exemptionQuoteMatches,
  exemptionRecordDigest,
  exemptQuoteDigest,
  findExemptQuoteLine,
  normalizeExemptQuote,
} from '../lib/exempt-protocol.mjs';

const sha12 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);

test('枚举：用户面 scope 仅 plan/review；记录面含 revoked；引文上限 1000', () => {
  assert.deepEqual([...EXEMPT_SCOPES], ['plan', 'review']);
  assert.deepEqual([...EXEMPT_RECORD_SCOPES], ['plan', 'review', 'revoked']);
  assert.equal(EXEMPT_QUOTE_MAX, 1000);
});

test('normalizeExemptQuote：trim/空值/行分隔符/码点上限', () => {
  assert.deepEqual(normalizeExemptQuote('  不用写计划，直接修  '), { ok: true, quote: '不用写计划，直接修' });
  assert.equal(normalizeExemptQuote('').ok, false);
  assert.equal(normalizeExemptQuote('   ').ok, false);
  assert.equal(normalizeExemptQuote('继续\n').ok, false);
  assert.equal(normalizeExemptQuote('a\r\nb').ok, false);
  assert.equal(normalizeExemptQuote('a\u2028b').ok, false);
  assert.equal(normalizeExemptQuote('字'.repeat(1000)).ok, true);
  assert.equal(normalizeExemptQuote('字'.repeat(1001)).ok, false);
});

test('checkExemptQuoteFace：plan scope 点名计划面、拒绝推进/目标指令', () => {
  for (const q of ['不用写计划，直接修', '这个不用走流程', '按方案执行，不用规划']) {
    assert.equal(checkExemptQuoteFace(q, 'plan').ok, true, q);
  }
  for (const q of ['继续', '先处理 X 再处理 Y', '逐项修复', '用户当轮已批准']) {
    assert.equal(checkExemptQuoteFace(q, 'plan').ok, false, q);
  }
  assert.equal(checkExemptQuoteFace('跳过评审直接做', 'review').ok, true);
  assert.equal(checkExemptQuoteFace('不用写计划', 'review').ok, false);
  assert.equal(checkExemptQuoteFace('跳过评审', 'bogus').ok, false);
});

test('checkExemptRevokeQuote：先归一（单行/上限）再点名撤销/流程面', () => {
  assert.equal(checkExemptRevokeQuote('撤销计划豁免，按正常评审计划走').ok, true);
  assert.equal(checkExemptRevokeQuote('退役这个豁免').ok, true);
  assert.equal(checkExemptRevokeQuote('继续').ok, false);
  assert.equal(checkExemptRevokeQuote('撤销\n计划').ok, false);
  assert.equal(checkExemptRevokeQuote('撤销' + '字'.repeat(1001)).ok, false);
  assert.equal(checkExemptRevokeQuote('   ').ok, false);
});

test('checkExemptDeclarationShape：scope/plan/planRoot 成对规则（不含 src）', () => {
  assert.equal(checkExemptDeclarationShape({
    skill: 'plan-execution', exempt: '不用写计划，直接修', scope: 'plan', hasPlan: false, hasPlanRoot: false,
  }).ok, true);
  assert.equal(checkExemptDeclarationShape({
    skill: 'plan-execution', exempt: '跳过评审直接做', scope: 'review', hasPlan: true, hasPlanRoot: false,
  }).ok, true);
  assert.equal(checkExemptDeclarationShape({
    skill: 'plan-execution', exempt: '跳过评审直接做', scope: 'review', hasPlan: false, hasPlanRoot: false,
  }).ok, false);
  assert.equal(checkExemptDeclarationShape({
    skill: 'plan-execution', exempt: '不用写计划', scope: 'plan', hasPlan: true, hasPlanRoot: false,
  }).ok, false);
  assert.equal(checkExemptDeclarationShape({
    skill: 'plan-execution', exempt: '跳过评审直接做', scope: 'review', hasPlan: true, hasPlanRoot: true,
  }).ok, false);
  assert.equal(checkExemptDeclarationShape({
    skill: 'plan-execution', exempt: '不用写计划', scope: 'plan', hasPlan: false, hasPlanRoot: true,
  }).ok, false);
  assert.equal(checkExemptDeclarationShape({
    skill: 'plan-execution', exempt: '不用写计划', scope: 'bogus', hasPlan: false, hasPlanRoot: false,
  }).ok, false);
  assert.equal(checkExemptDeclarationShape({
    skill: 'plan-execution', exempt: '不用写计划', hasPlan: false, hasPlanRoot: false,
  }).ok, false);
  assert.equal(checkExemptDeclarationShape({
    skill: 'brainstorming', exempt: '不用写计划', scope: 'plan', hasPlan: false, hasPlanRoot: false,
  }).ok, false);
  assert.equal(checkExemptDeclarationShape({
    skill: 'plan-execution', exempt: '', scope: 'plan', hasPlan: false, hasPlanRoot: false,
  }).ok, false);
  assert.equal(checkExemptDeclarationShape({
    skill: 'plan-execution', exempt: '继续', scope: 'plan', hasPlan: false, hasPlanRoot: false,
  }).ok, false);
});

test('findExemptQuoteLine：全角/半角冒号、行首空白、围栏外、多行歧义', () => {
  const a = findExemptQuoteLine('豁免引文：跳过评审直接做');
  assert.equal(a.found, true);
  assert.equal(a.quote, '跳过评审直接做');
  assert.equal(a.conflict, false);

  const b = findExemptQuoteLine('  豁免引文: 不用写计划  ');
  assert.equal(b.found, true);
  assert.equal(b.quote, '不用写计划');

  const fenced = [
    '```text',
    '豁免引文：围栏内',
    '```',
    '豁免引文：围栏外',
  ].join('\n');
  const c = findExemptQuoteLine(fenced);
  assert.equal(c.found, true);
  assert.equal(c.quote, '围栏外');

  const tie = ['豁免引文：同一句', '豁免引文：同一句'].join('\n');
  const d = findExemptQuoteLine(tie);
  assert.equal(d.found, true);
  assert.equal(d.count, 2);
  assert.equal(d.conflict, false);

  const conflict = ['豁免引文：甲', '豁免引文：乙'].join('\n');
  const e = findExemptQuoteLine(conflict);
  assert.equal(e.found, true);
  assert.equal(e.conflict, true);

  assert.equal(findExemptQuoteLine('豁免引文：').found, false);
});

test('exemptionQuoteMatches：trim 全等、内部空白保留、大小写敏感', () => {
  assert.equal(exemptionQuoteMatches(' 跳过评审 ', '跳过评审'), true);
  assert.equal(exemptionQuoteMatches('跳过  评审', '跳过 评审'), false);
  assert.equal(exemptionQuoteMatches('Review', 'review'), false);
});

test('摘要分离：quoteSha 与 record digest 各自单源', () => {
  assert.equal(exemptQuoteDigest('abc'), sha12('abc'));
  assert.equal(exemptionRecordDigest('内部任务-1', 'abc'), sha12('内部任务-1|abc'));
  assert.notEqual(exemptQuoteDigest('abc'), exemptionRecordDigest('内部任务-1', 'abc'));
});
