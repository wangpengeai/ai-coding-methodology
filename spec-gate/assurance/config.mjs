// 文件：config.mjs
// 描述：config.py 的 JS 实现（唯一实现；迁移史见 内部决策-051）（内部决策-051 运行时归一·阶段1a）——内部治理状态 三级降级
//       读配置（缺失→default、损坏/根非对象→unparsable-default 强干涉项按缺省、正常→只拷
//       已知键丢弃未知键）＋评审覆盖阈值。bug-for-bug 复刻。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
// 已登记边界（门②发现 5）：浮点整值 token（如 5.0）经 JSON.parse 塌缩为整数→threshold 受理，
// Python 解析为 float→拒绝回 8（common.mjs 边界①同族——token 形态经 parse 不可恢复，凭据
// 值域手写浮点阈值不可达）。
import { readUtf8Strict } from './common.mjs';
import { join } from 'node:path';

const DEFAULT_STEP_THRESHOLD = 8;

const DEFAULT_CONFIG = {
  schemaVersion: '1.0.0',
  planCheckBlock: false,
  // G03（内部任务-241）：治理报告必检开关——内部接口-18 的 required 语义经此键接线；
  // 旧实现只从 DEFAULT_CONFIG 拷已知键，该键被静默丢弃导致 required 恒 false。
  governanceRequired: false,
  reviewCoverage: { planStepThreshold: DEFAULT_STEP_THRESHOLD },
};

const CONFIG_PATH = '.sdd/assurance.json';

/**
 * 读配置（对齐 config.load_config 三级降级＋source 标注）。
 * @param {string} root 项目根
 * @returns {Record<string, unknown>} 含 source ∈ default|unparsable-default|file
 */
export function loadConfig(root) {
  let raw;
  try {
    raw = readUtf8Strict(join(root, CONFIG_PATH));
  } catch (e) {
    // 门②发现 6＋终审发现 7：ENOENT（缺失）与 EISDIR（目录占位——Python is_file() 先行
    // 拦截归 default）归 default；其余读错误（EACCES 等 OSError 族）与无效 UTF-8＝
    // unparsable-default（Python OSError/UnicodeDecodeError 同档）
    if (e.code === 'ENOENT' || e.code === 'EISDIR') return { ...DEFAULT_CONFIG, source: 'default' };
    if (/不是有效 UTF-8/.test(e.message)) return { ...DEFAULT_CONFIG, source: 'unparsable-default' };
    if (e.code !== undefined) return { ...DEFAULT_CONFIG, source: 'unparsable-default' };
    throw e;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('根非对象');
    }
    const merged = { ...DEFAULT_CONFIG };
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (key in parsed) merged[key] = parsed[key];
    }
    if (typeof merged.governanceRequired !== 'boolean') {
      // 强干涉项坏形态不静默放行：按缺省降级并注明（对齐 planCheckBlock/reviewCoverage 纪律）
      return { ...DEFAULT_CONFIG, source: 'unparsable-default' };
    }
    return { ...merged, source: 'file' };
  } catch {
    // 配置损坏不静默放行强干涉项：按缺省降级并注明
    return { ...DEFAULT_CONFIG, source: 'unparsable-default' };
  }
}

/**
 * 评审覆盖阈值（对齐 config.review_coverage_threshold：int 排 bool 且 >0 才受理，否则回 8）。
 * @param {string} root
 * @returns {number}
 */
export function reviewCoverageThreshold(root) {
  const cfg = loadConfig(root);
  const review = cfg.reviewCoverage;
  if (review !== null && typeof review === 'object' && !Array.isArray(review)) {
    const raw = review.planStepThreshold;
    if (typeof raw === 'number' && Number.isInteger(raw) && !Number.isNaN(raw) && raw > 0) return raw;
  }
  return DEFAULT_STEP_THRESHOLD;
}
