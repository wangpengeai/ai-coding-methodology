// 文件：observation-capabilities.mjs
// 描述：运行观测能力域**纯数据驱动 resolver**（内部规则-13 / 内部决策-063 修正案 1 决策 13，
//       2026-10-24 内部任务-192）——把「本宿主能观测到什么」这一事实从代码里搬进数据资产：
//       唯一人工事实源＝内部接口-1「运行观测能力登记」表，核心消费其机器可读镜像
//       `observation-capability-contract.json`（sourceRef/contractVersion/hosts/四域五态）。
//       为什么无宿主名分支：核心件不得出现宿主术语（B-M15-7），且「核心内置默认表」会造成
//       与 内部接口-1 的双源漂移（plan-review round2 工程 N1 实证）。宿主 token 只作**查表键**：
//       新增宿主＝改镜像＋内部接口-1＋对拍测试，本文件零改动。
//       保守语义：env 声明缺失时按镜像 `whenUndeclared` 取缺省（ZCode 镜像为原生默认⇒零告警；
//       其余宿主镜像标 degraded⇒就绪面提示「能力域未声明」）；镜像缺该宿主/坏表/坏 env
//       一律保守 degraded 且不抛错（fail-open——就绪面只告警不阻断会话）。
// 作者：wangp  创建：2026-10-24  版权：MIT（见 workflow/LICENSE）
// 用法：被 session-start.mjs（就绪面）消费；`node` 直跑无副作用（纯库）。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 四能力域（镜像键集常量；与 内部接口-1 表行一一对应）。 */
export const CAPABILITY_DOMAINS = Object.freeze(['failureFacts', 'hookFailure', 'injection', 'selfCheck']);
/** 五态取值闭集（原生可用/适配层供给/降级可用/不可用/未验证）。 */
export const CAPABILITY_VALUES = Object.freeze(['native', 'adapter', 'degraded', 'unavailable', 'unverified']);
/** 保守缺省（缺失/非法/未知宿主一律它——永不高估能力）。 */
export const CONSERVATIVE_VALUE = 'degraded';
/** 声明值形态（宿主适配层 env 可用描述性短串，如 error-object/relay；五态是登记词表）。 */
export const DECLARATION_GRAMMAR = /^[A-Za-z][A-Za-z0-9+_.-]{0,39}$/;

const HERE = dirname(fileURLToPath(import.meta.url));
/** 镜像默认路径（同目录数据资产；测试可经 path 注入替代）。 */
export const DEFAULT_CONTRACT_PATH = join(HERE, 'observation-capability-contract.json');

/**
 * 加载镜像（幂等、容错）：结构不合约束即返回 `{ok:false}`——调用方按保守 degraded 处理，
 * 绝不抛错（就绪面告警而非阻断）。
 *
 * **两键生产读取（内部决策-063 修正案 3 决策 21.1，内部任务-195）**：镜像的 `declarationGrammar` /
 * `conservativeValue` 此前只在测试里被读取（JS 侧另有一份硬编码常量 = 双源），现由本函数
 * 读出并交 resolver 作默认值；单键缺失/坏形态回退模块常量（fail-open——一个坏键不拖垮整份表）。
 * @param {{path?: string}} [opts]
 * @returns {{ok: boolean, contractVersion?: number, sourceRef?: string, hosts?: object, domains?: string[],
 *            values?: string[], declarationGrammar?: RegExp, conservativeValue?: string}}
 */
export function loadContract(opts = {}) {
  const path = typeof opts.path === 'string' && opts.path ? opts.path : DEFAULT_CONTRACT_PATH;
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ok: false };
  }
  if (!data || typeof data !== 'object') return { ok: false };
  if (data.schemaVersion !== 1 || !Number.isFinite(data.contractVersion)) return { ok: false };
  if (!data.hosts || typeof data.hosts !== 'object') return { ok: false };
  if (!Array.isArray(data.capabilityDomains) || !Array.isArray(data.capabilityValues)) return { ok: false };
  return {
    ok: true,
    contractVersion: data.contractVersion,
    sourceRef: typeof data.sourceRef === 'string' ? data.sourceRef : '',
    hosts: data.hosts,
    domains: data.capabilityDomains,
    values: data.capabilityValues,
    declarationGrammar: grammarOf(data.declarationGrammar),
    conservativeValue: conservativeOf(data.conservativeValue),
  };
}

/**
 * 镜像 grammar 解析（坏形态回退模块常量，不抛）。
 * @param {unknown} raw 镜像 `declarationGrammar` 原文
 * @returns {RegExp}
 */
function grammarOf(raw) {
  if (typeof raw !== 'string' || raw === '') return DECLARATION_GRAMMAR;
  try {
    return new RegExp(raw);
  } catch {
    return DECLARATION_GRAMMAR;
  }
}

/**
 * 镜像 conservativeValue 归一（非空字符串才认；否则模块常量）。
 * @param {unknown} raw 镜像 `conservativeValue` 原文
 * @returns {string}
 */
function conservativeOf(raw) {
  return typeof raw === 'string' && raw !== '' ? raw : CONSERVATIVE_VALUE;
}

/** 四域全置保守值（域集可由镜像驱动，内部任务-244 Q12）。 */
function conservativeDomains(value = CONSERVATIVE_VALUE, names = CAPABILITY_DOMAINS) {
  const out = {};
  for (const d of names) out[d] = value;
  return out;
}

/**
 * 解析运行观测能力域（纯函数）：`env` 为适配层注入的声明 JSON（`WF_OBSERVATION_CAPABILITIES`），
 * 缺省时按镜像 hosts 表落 `whenUndeclared`；任何非法形态保守 degraded，不抛。
 *
 * 返回面语义：
 *  - `source ∈ env|mirror|conservative`（声明来源，诊断用）；
 *  - `ok`＝声明**结构**合法（false ⇒ 就绪面报「能力域声明非法」）；
 *  - `degraded`＝能力面未达原生默认（true ⇒ 就绪面报「能力域未声明/降级」）；
 *  - `domains`＝四域取值（env 原值或镜像值；保守态全 degraded）。
 * @param {string|object|undefined} env 声明 JSON 文本（或已解析对象；undefined/空＝未声明）
 * @param {object} [contract] {@link loadContract} 结果（缺省现场加载）
 * @param {string} [hostToken] 宿主 token（仅作镜像查表键；缺省 unknown）
 * @returns {{ok: boolean, degraded: boolean, source: 'env'|'mirror'|'conservative', host: string,
 *            domains: Record<string, string>, reasons: string[], contractVersion: number}}
 */
export function resolveCapabilities(env, contract = loadContract(), hostToken = 'unknown') {
  const host = typeof hostToken === 'string' && hostToken ? hostToken : 'unknown';
  const ct = contract && contract.ok ? contract : { ok: false };
  const contractVersion = ct.ok ? ct.contractVersion : 0;
  // 镜像两键生产读取（内部决策-063 修正案 3 决策 21.1）：坏镜像/单键坏回退模块常量（fail-open）。
  const grammar = ct.ok && ct.declarationGrammar instanceof RegExp ? ct.declarationGrammar : DECLARATION_GRAMMAR;
  const conservative = ct.ok && typeof ct.conservativeValue === 'string' && ct.conservativeValue ? ct.conservativeValue : CONSERVATIVE_VALUE;
  // 内部任务-244 Q12：镜像 `capabilityDomains`/`capabilityValues` 由生产 resolver 消费（原仅测试读取，
  // 违反 内部决策-063 修正案 3 决策 21.4）。域集/五态词表以镜像为准，缺失/坏形态回退模块常量。
  const domainNames = ct.ok && Array.isArray(ct.domains) && ct.domains.length > 0
    ? ct.domains.filter((d) => typeof d === 'string' && d !== '')
    : CAPABILITY_DOMAINS;
  const valueSet = new Set(ct.ok && Array.isArray(ct.values) && ct.values.length > 0 ? ct.values : CAPABILITY_VALUES);
  const declared = typeof env === 'string' ? env.trim() : '';
  if (declared !== '' || (env && typeof env === 'object')) {
    let parsed = env;
    if (typeof env === 'string') {
      try {
        parsed = JSON.parse(env);
      } catch {
        return { ok: false, degraded: true, source: 'conservative', host, domains: conservativeDomains(conservative, domainNames), reasons: ['env-json-invalid'], contractVersion };
      }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, degraded: true, source: 'conservative', host, domains: conservativeDomains(conservative, domainNames), reasons: ['env-not-object'], contractVersion };
    }
    const reasons = [];
    const domains = {};
    for (const key of Object.keys(parsed)) {
      if (!domainNames.includes(key)) reasons.push(`unknown-domain:${key}`);
    }
    for (const d of domainNames) {
      const v = parsed[d];
      if (typeof v !== 'string' || !grammar.test(v)) {
        reasons.push(`invalid-value:${d}`);
        domains[d] = conservative;
      } else {
        domains[d] = v;
      }
    }
    if (reasons.length > 0) return { ok: false, degraded: true, source: 'conservative', host, domains, reasons, contractVersion };
    return { ok: true, degraded: false, source: 'env', host, domains, reasons: [], contractVersion };
  }
  const entry = ct.ok && ct.hosts ? ct.hosts[host] : null;
  if (!entry || typeof entry !== 'object') {
    return { ok: true, degraded: true, source: 'conservative', host, domains: conservativeDomains(conservative, domainNames), reasons: [`unknown-host:${host}`], contractVersion };
  }
  // 镜像域值按五态词表校验（Q12）：非法值回落保守值并记原因（degraded 可见）。
  const reasons = [];
  const domains = {};
  for (const d of domainNames) {
    const raw = entry.domains && typeof entry.domains[d] === 'string' ? entry.domains[d] : conservative;
    if (raw !== conservative && !valueSet.has(raw)) {
      reasons.push(`invalid-mirror-value:${d}`);
      domains[d] = conservative;
    } else {
      domains[d] = raw;
    }
  }
  const whenRaw = typeof entry.whenUndeclared === 'string' ? entry.whenUndeclared : conservative;
  const whenUndeclared = whenRaw === conservative || valueSet.has(whenRaw) ? whenRaw : conservative;
  if (whenUndeclared !== whenRaw) reasons.push('invalid-when-undeclared');
  return { ok: true, degraded: whenUndeclared !== 'native' || reasons.length > 0, source: 'mirror', host, domains, reasons, contractVersion };
}
