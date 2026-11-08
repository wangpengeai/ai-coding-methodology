// 文件：strategies/map.mjs
// 描述：map 族策略执行器（内部决策-037 决策 2，一族一文件）——工具词表映射（direction 决定取宽/
//       取首：widen=展开全部别名，one-to-one=取首个别名；未知词原样；缺省/空串/'*'/非字符串
//       一律返回 undefined＝全匹配，与适配层 normalizeMatcher 值域对齐）、危险文案位迁移
//       （readPriority 读取序 / rename 目标键缺失才搬迁）、命名空间变形（kebab 归一 + 前缀
//       拼接 + 形态校验：非法名返回空串交调用方 skip）。
//       执行器签名统一为 (env, hp, ports)：env={context,host,matrix}，hp=params[host]。
// 作者：wangp 创建：2026-10-01  版权：MIT（见 workflow/LICENSE）
// 用法：被 src/engine.mjs 汇总消费（executors 表），不直接被外部调用
// 自检：node --test "plugin-core/tests/engine.test.mjs"

/** 名字形态（与适配层 SKILL_NAME_RE 同款：kebab-case）。 */
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** kebab 归一（非字母数字串折单连字符并去首尾）。 */
const kebab = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * 规则 id → 执行器映射（引擎按 ruleId 分派）。
 */
export const executors = {
  'tool-vocab-map': (env, hp) => {
    const raw = env.context.matcher;
    if (typeof raw !== 'string') return undefined; // 非字符串＝全匹配（值域对齐 normalizeMatcher）
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed === '*') return undefined; // 缺省/空串/'*' 均全匹配
    const words = trimmed.split('|').map((w) => w.trim()).filter((w) => w !== '');
    if (words.length === 0) return undefined;
    const widen = hp.direction === 'widen';
    const oneToOne = hp.direction === 'one-to-one';
    if (!widen && !oneToOne) throw new Error(`tool-vocab-map: 不支持的 direction ${String(hp.direction)}（合法：widen|one-to-one）`);
    const out = [];
    for (const word of words) {
      const mappedRaw = hp.table && Object.hasOwn(hp.table, word) && Array.isArray(hp.table[word]) ? hp.table[word] : [word];
      const mapped = oneToOne ? mappedRaw.slice(0, 1) : mappedRaw; // one-to-one 取首个映射
      for (const alias of mapped) if (!out.includes(alias)) out.push(alias);
    }
    return out.join('|');
  },

  'message-slot-migration': (env, hp) => {
    const envelope = env.context.envelope && typeof env.context.envelope === 'object' ? env.context.envelope : {};
    if (Array.isArray(hp.readPriority)) {
      for (const key of hp.readPriority) {
        if (typeof envelope[key] === 'string' && envelope[key] !== '') return envelope[key];
      }
      return '';
    }
    if (hp.rename && typeof hp.rename === 'object') {
      const out = { ...envelope };
      for (const [from, to] of Object.entries(hp.rename)) {
        // 目标键已存在时不覆盖（与既有 shim 的 `??` 语义等价）
        if (Object.hasOwn(out, from) && !Object.hasOwn(out, to)) {
          out[to] = out[from];
          delete out[from];
        }
      }
      return out;
    }
    return undefined;
  },

  'namespace-transform': (env, hp) => {
    if (hp.collision !== 'first-wins-warn') throw new Error(`namespace-transform: 不支持的 collision ${String(hp.collision)}（合法：first-wins-warn）`);
    if (hp.prefix !== undefined && hp.prefix !== 'plugin-name') throw new Error(`namespace-transform: 不支持的 prefix ${String(hp.prefix)}（合法：plugin-name）`);
    const local = kebab(env.context.dirName);
    const prefix = hp.prefix === 'plugin-name' ? kebab(env.context.plugin) : '';
    const name = prefix === '' ? local : `${prefix}${hp.separator ?? '-'}${local}`;
    return NAME_RE.test(name) ? name : ''; // 形态非法 → 空串（调用方据此 skip）
  },
};
