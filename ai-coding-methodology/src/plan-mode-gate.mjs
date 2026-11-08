// 文件：plan-mode-gate.mjs
// 描述：内部任务-272 内部未决-236 DSH plan 模式识别门控（读宿主 ctx.get('planMode') 服务；缺失/异常 fail-open，不缓存 engaged 状态）
// 作者：wangp  创建：2026-11-01  版权：MIT（见仓库 LICENSE）

/**
 * 创建 plan 模式门控。每次调用都重新解析服务与 agent 状态（不缓存 engaged）；服务缺失或读取异常一律返回 false。
 * @param {{readService: () => any, info?: (message: string) => void, sidOf?: (agent: any) => string}} deps 依赖：服务读取、日志、会话 id 提取
 * @returns {{isEngaged: (agent: any) => boolean}} 门控对象
 */
export function createPlanModeGate(deps) {
  const info = typeof deps?.info === 'function' ? deps.info : () => {};
  const sidOf = typeof deps?.sidOf === 'function' ? deps.sidOf : () => '';
  const infoOnce = new Set();
  let serviceInfoLogged = false;
  return {
    isEngaged(agent) {
      const svc = deps.readService();
      if (!svc || typeof svc.get !== 'function') {
        if (!serviceInfoLogged) {
          serviceInfoLogged = true;
          info('ai-coding-methodology: plan 模式识别：宿主 planMode 服务缺失（fail-open，行为同批前）');
        }
        return false;
      }
      try {
        const state = svc.get(agent);
        return state?.active === true || state?.pending === true;
      } catch {
        const sid = sidOf(agent);
        if (sid !== '' && !infoOnce.has(sid)) {
          infoOnce.add(sid);
          info(`ai-coding-methodology: plan 模式判定失败（session=${sid}，fail-open）`);
        }
        return false;
      }
    },
  };
}
