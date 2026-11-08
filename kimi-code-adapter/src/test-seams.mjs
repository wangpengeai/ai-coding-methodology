// 文件：kimi-code-adapter/src/test-seams.mjs
// 描述：测试缝登记面（内部未决-278）——生产代码读取 `KIMI_TEST_*` 的唯一入口。
//       缝只在测试态生效（环境变量恰为 '1'），未登记名字具名抛错（防拼写错误静默恒假）。
//       新增缝必须同时登记于此并在 README「测试」节写明；禁止在业务文件散读环境变量。
// 作者：wangp  创建：2026-11-06  版权：MIT（见 workflow/LICENSE）
// 依据：内部规格 内部未决-278

/** 测试缝登记表：缝名（代码内使用）→ 环境变量名（外部注入）。新增缝必须同时登记于此。 */
const TEST_SEAMS = Object.freeze({
  rollbackFail: 'KIMI_TEST_ROLLBACK_FAIL',
  pruneLock: 'KIMI_TEST_PRUNE_LOCK',
});

/**
 * 读取测试缝开关：环境变量恰为 '1' 时生效（其余值一律视为关闭）。
 * @param {'rollbackFail'|'pruneLock'} name 登记表中的缝名
 * @returns {boolean} 开启即 true
 */
export function testSeam(name) {
  const envName = TEST_SEAMS[name];
  if (typeof envName !== 'string') throw new Error(`test-seams: 未登记的测试缝 ${String(name)}`);
  return process.env[envName] === '1';
}
