// 文件：os-observe-switch.mjs
// 描述：team-governance SessionStart os-observe 段的关闭开关纯函数（内部任务-268 / 内部决策-068 决策 3）——
//       唯一判定点：`AI_CODING_OS_OBSERVE` **恰为字符串 '0'** 时跳过 os-observe 浮现段与机会式
//       补位采集；治理摘要段不受影响。该缝只由宿主适配层按用户配置注入（DSH Config.osObservation），
//       team-governance 不新增配置文件/状态目录；其余取值与异常保持现行两段式（fail-open）。
//       依据：内部决策-068、内部模块-14 内部规则-14/内部验收-27；纯函数零依赖。
// 作者：wangp  创建：2026-10-31  版权：MIT（见 team-governance/LICENSE）

/**
 * 是否跳过 os-observe 两段。
 * @param {Record<string, string|undefined>} env 进程环境（真实 process.env 或测试夹具）
 * @returns {boolean}
 */
export function shouldSkipOsObserve(env) {
  return env?.AI_CODING_OS_OBSERVE === '0';
}
