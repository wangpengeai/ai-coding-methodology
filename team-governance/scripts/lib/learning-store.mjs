// 文件：learning-store.mjs
// 描述：结构化 learning 的 observed 态持久层（内部模块-15/内部决策-019 tg 拉取联动，内部需求-12）——
//       learning.mjs 是纯函数库（promoteLearning/validateLearning，无 I/O），observed
//       态对象的落盘位置由调用方决定；本库就是这个决定：.ai-governance/runtime/learnings/
//       observed.jsonl（runtime 运行态，gitignore；adopted 转正式时由治理流程另册）。
//       写路径 O_APPEND 追加（并发安全），幂等去重在读侧（同 learningId 只保留首条）。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { redactChecked, RedactionResidualError } from './redaction.mjs';
import { readJsonlTolerant } from './jsonl.mjs';

/**
 * observed 态 learning 文件路径。
 * @param {string} root 项目根
 * @returns {string}
 */
export function observedFile(root) {
  return join(root, '.ai-governance', 'runtime', 'learnings', 'observed.jsonl');
}

/**
 * 追加一条 observed learning（调用方先经 promoteLearning 构造对象；learningId 必填
 * ——生成唯一入口在 CLI 侧 promote 之前，本库不再持有第二份缺省生成式）。
 * @param {string} root 项目根
 * @param {object} rec learning 对象（learningId 必填）
 * @returns {{ok: boolean, learningId?: string}}
 * @throws {import('./redaction.mjs').RedactionResidualError} 脱敏后残余命中（调用方按工具错退 2）
 */
export function appendObserved(root, rec) {
  if (!rec || typeof rec.learningId !== 'string' || !rec.learningId) return { ok: false };
  try {
    const line = redactChecked({ recordedAt: new Date().toISOString(), ...rec });
    const file = observedFile(root);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(line) + '\n');
    return { ok: true, learningId: line.learningId };
  } catch (e) {
    if (e instanceof RedactionResidualError) throw e;
    // 内部任务-257（P5-5）：持久化 IO 失败回传 code，供 CLI 映射工具错退 2（不吞 errno）
    return { ok: false, code: e?.code ?? null, error: String(e?.message ?? e) };
  }
}

/**
 * 读取全部 observed learning：坏行跳过；同 learningId 只保留首条（读侧幂等）。
 * @param {string} root 项目根
 * @returns {Array<object>}
 */
export function readObserved(root) {
  const file = observedFile(root);
  if (!existsSync(file)) return [];
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const seen = new Set();
  const out = [];
  for (const d of readJsonlTolerant(text).records) { // 内部任务-257 P5-2：JSONL 解析单源
    if (!d || typeof d.learningId !== 'string' || !d.learningId) continue;
    if (seen.has(d.learningId)) continue;
    seen.add(d.learningId);
    out.push(d);
  }
  return out;
}
