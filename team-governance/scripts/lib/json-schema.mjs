// 文件：json-schema.mjs
// 描述：受控 JSON Schema 子集验证器（内部规则-2 / 内部决策-2）——只支持本项目 schema 实际
//       使用的子集；遇未支持关键字抛 SchemaError（退出 2 语义），不静默忽略。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）

/** 未支持关键字即响亮失败（防止"假验证通过"）。 */
export class SchemaError extends Error {
  /**
   * @param {string} keyword
   */
  constructor(keyword) {
    super(`schema 子集不支持关键字「${keyword}」——按 D-M12-2 响亮失败，不静默忽略`);
    this.name = 'SchemaError';
  }
}

const SUPPORTED = new Set([
  'type', 'required', 'properties', 'additionalProperties', 'items', 'minItems',
  'enum', 'const', 'pattern', 'minimum', 'maximum',
  'oneOf', 'anyOf',
]);

/** 元关键字：可出现在 schema 中但不参与校验（内部接口-1 §4.1 / 内部规则-2，2026-10-29 内部任务-253）。 */
const META = new Set(['$schema', 'title', 'description', 'schemaVersion']);

/**
 * 递归预检 schema 结构：`$ref` 与数组形态 `type` 在任何嵌套深度都响亮失败（不静默放行）。
 * @param {unknown} schema
 */
function assertSupportedSchema(schema) {
  const badShape = (k, v) => { throw new SchemaError(`${k}（形态非法：${Array.isArray(v) ? 'array' : typeof v}）`); };
  const shapeChecks = (s) => {
    if (s.properties !== undefined && (typeof s.properties !== 'object' || s.properties === null || Array.isArray(s.properties))) badShape('properties', s.properties);
    if (s.enum !== undefined && !Array.isArray(s.enum)) badShape('enum', s.enum);
    if (s.required !== undefined && !Array.isArray(s.required)) badShape('required', s.required);
    for (const k of ['oneOf', 'anyOf']) {
      if (s[k] !== undefined && !Array.isArray(s[k])) badShape(k, s[k]);
    }
  };
  if (Array.isArray(schema)) {
    for (const s of schema) assertSupportedSchema(s);
    return;
  }
  if (!schema || typeof schema !== 'object') return;
  shapeChecks(schema);
  for (const [key, value] of Object.entries(schema)) {
    if (key === '$ref') throw new SchemaError('$ref');
    if (key === 'type' && Array.isArray(value)) throw new SchemaError('type（数组形态）');
    if (key === 'properties' && value && typeof value === 'object') {
      for (const sub of Object.values(value)) assertSupportedSchema(sub);
      continue;
    }
    if (key === 'items' || key === 'oneOf' || key === 'anyOf') assertSupportedSchema(value);
    if (key === 'additionalProperties' && value && typeof value === 'object') assertSupportedSchema(value);
  }
}

/**
 * 验证实例against schema 子集；返回诊断数组（空=通过）。
 * 严格化语义（内部任务-253）：`$ref` 与数组形态 `type` 不受支持且响亮失败；`oneOf`＝恰一支命中；`anyOf`＝至少一支；
 * 未知 `type` 值同样响亮失败。
 * 豁免面（与 内部模块-12 内部规则-2 一致）：元关键字 `$schema/title/description/schemaVersion` 不参与校验；
 * `x-*` 为显式扩展关键字（不参与校验）。
 * @param {unknown} instance
 * @param {Record<string, unknown>} schema
 * @param {string} [path]
 * @returns {Array<{path: string, message: string}>}
 */
export function validateAgainstSchema(instance, schema, path = '$') {
  assertSupportedSchema(schema);
  for (const key of Object.keys(schema)) {
    if (META.has(key)) continue;
    if (!SUPPORTED.has(key) && !key.startsWith('x-')) throw new SchemaError(key);
  }
  /** @type {Array<{path: string, message: string}>} */
  const diags = [];
  if (schema.oneOf) {
    const hits = schema.oneOf.filter((s) => validateAgainstSchema(instance, s, path).length === 0).length;
    if (hits !== 1) diags.push({ path, message: `oneOf 命中 ${hits} 支（须恰一支）` });
  }
  if (schema.anyOf) {
    const anyOk = schema.anyOf.some((s) => validateAgainstSchema(instance, s, path).length === 0);
    if (!anyOk) diags.push({ path, message: 'anyOf 全分支不中' });
  }
  if (schema.type) {
    const t = schema.type;
    // 未知 type 值不得静默通过（内部规则-2 / 内部接口-1 §4.1）
    if (!['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'].includes(t)) throw new SchemaError(`type:${t}`);
    const okType = t === 'object' ? typeof instance === 'object' && instance !== null && !Array.isArray(instance)
      : t === 'array' ? Array.isArray(instance)
      : t === 'string' ? typeof instance === 'string'
      : t === 'integer' ? typeof instance === 'number' && Number.isInteger(instance)
      : t === 'number' ? typeof instance === 'number'
      : t === 'boolean' ? typeof instance === 'boolean'
      : t === 'null' ? instance === null : true;
    if (!okType) return [{ path, message: `类型应为 ${t}，实得 ${Array.isArray(instance) ? 'array' : typeof instance}` }];
  }
  if (schema.const !== undefined && instance !== schema.const) {
    diags.push({ path, message: `应为常量 ${JSON.stringify(schema.const)}` });
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(instance)) {
    diags.push({ path, message: `不在枚举 ${JSON.stringify(schema.enum)}` });
  }
  if (typeof instance === 'string' && schema.pattern && !new RegExp(schema.pattern).test(instance)) {
    diags.push({ path, message: `不匹配 pattern ${schema.pattern}` });
  }
  if (typeof instance === 'number') {
    if (typeof schema.minimum === 'number' && instance < schema.minimum) diags.push({ path, message: `小于下界 ${schema.minimum}` });
    if (typeof schema.maximum === 'number' && instance > schema.maximum) diags.push({ path, message: `大于上界 ${schema.maximum}` });
  }
  if (Array.isArray(instance)) {
    if (schema.minItems !== undefined && instance.length < schema.minItems) {
      diags.push({ path, message: `元素数 ${instance.length} < ${schema.minItems}` });
    }
    if (schema.items) {
      instance.forEach((v, i) => diags.push(...validateAgainstSchema(v, schema.items, `${path}[${i}]`)));
    }
  }
  if (instance && typeof instance === 'object' && !Array.isArray(instance)) {
    if (Array.isArray(schema.required)) {
      for (const req of schema.required) {
        if (!(req in instance)) diags.push({ path, message: `缺必填字段 ${req}` });
      }
    }
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(instance)) {
      if (k in props) diags.push(...validateAgainstSchema(v, props[k], `${path}.${k}`));
      else if (schema.additionalProperties === false) diags.push({ path: `${path}.${k}`, message: '额外字段被禁止' });
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        diags.push(...validateAgainstSchema(v, schema.additionalProperties, `${path}.${k}`));
      }
    }
  }
  return diags;
}
