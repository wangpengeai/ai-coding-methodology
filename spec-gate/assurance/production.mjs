// 文件：production.mjs
// 描述：production.py 的 JS 实现（唯一实现；迁移史见 内部决策-051） CLI 门面（内部决策-051 运行时归一·阶段1b）——init/status/
//       advance/assess/recover 五操作只做参数解析与调用编排（内部接口-13 / 内部规则-1）；
//       业务规则全在 model/policy/store。退出码 0=成功/通过、1=内容或政策阻断（含坏
//       changeId 经 _change_path 抛 ValueError→1——与 cli.py 的 argparse type 退 2 分叉
//       系原 Python 实现（迁移史见 内部决策-051）事实 bug-for-bug）、2=工具/参数/配置错误。stdout＝indent 2 JSON。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
import { statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { loadJson } from './common.mjs';
import { isMainModule } from '../core/validator/core/pycompat.mjs';
import { ProductionValueError } from './production_model.mjs';
import { assessClaim, resolveRequirements } from './production_policy.mjs';
import { advance as storeAdvance, createChange, readStatus, recover as storeRecover } from './production_store.mjs';

/** 直跑入口守卫（内部任务-241 步骤18 Q10）：isMainModule 单一实现（core pycompat，realpath 两段归一）。 */
const INVOKED_DIRECTLY = isMainModule(import.meta.url);

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function usageExit2(msg) {
  process.stderr.write(`${msg}\n用法：node production.mjs <init|status|advance|assess|recover> …（IF-COLLAB-13）\n`);
  return 2;
}

/** 相对路径按 **cwd** 解析（对齐原 Python 实现（迁移史见 内部决策-051） `Path(args.profile)`——与 `--project-root` 无关；终审发现 3）。
 *  绝对路径原样。 */
function pathArg(p) {
  return isAbsolute(p) ? p : resolve(p);
}

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

/**
 * CLI 主入口（对齐 production.main：返回 int 退出码；stdout indent=2 JSON）。
 * @param {string[]} argv @param {string} [rootArg] 项目根（缺省 cwd——测试缝）
 * @returns {number}
 */
export function main(argv, rootArg) {
  let root = rootArg ?? process.cwd();
  const args = [...argv];
  // 全局 --project-root（原 Python 实现（迁移史见 内部决策-051） argparse 面；计划 D.2 的四 skill 命令行依赖它，门① B2）
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--project-root') {
      if (i + 1 >= args.length) return usageExit2('--project-root 缺值');
      root = resolve(args[i + 1]);
      args.splice(i, 2);
      break;
    }
    if (args[i].startsWith('--project-root=')) {
      root = resolve(args[i].slice('--project-root='.length));
      args.splice(i, 1);
      break;
    }
  }
  try {
    return dispatch(args, root);
  } catch (e) {
    // 原 Python 实现（迁移史见 内部决策-051）：except ValueError → 1；except (OSError, JSONDecodeError) → 2。JSONDecodeError 是
    // ValueError 子类、按 except 顺序实际落 1（门① B4 实测）。JS：SyntaxError（JSON.parse）、
    // ProductionValueError、loadJson 的根类型/UTF-8 错（原 Python 实现（迁移史见 内部决策-051） ValueError 族）→ 1；
    // 其余（fs errno/未知工具错）→ 2（终审发现 4）。
    if (isValueError(e)) {
      process.stderr.write(`production：${e.message}\n`);
      return 1;
    }
    process.stderr.write(`production 工具错误：${e.message}\n`);
    return 2;
  }
}

function isValueError(e) {
  return e instanceof ProductionValueError || e instanceof SyntaxError
    || /JSON 根不是对象|不是有效 UTF-8/.test(String(e && e.message ? e.message : ''));
}

const CMD_FLAGS = {
  init: ['task-id', 'profile'],
  status: ['change'],
  advance: ['change', 'to', 'evidence', 'task-id', 'commit-sha', 'artifact-digest', 'environment', 'not-applicable', 'incident-ref'],
  assess: ['change', 'claim', 'context', 'impact'],
  recover: ['change'],
};

/** argparse 同构参数解析（终审阻塞 1）：未知旗标/多余位置/旗标缺值→错误（调用方退 2）；
 *  `--flag=value` 与 `--flag value` 均受理；`--impact` 可重复。 */
function parseArgs(rest, allowed) {
  const flags = {};
  const extra = [];
  for (let i = 0; i < rest.length; i += 1) {
    const tok = rest[i];
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      let name;
      let value;
      if (eq > 2) {
        name = tok.slice(2, eq);
        value = tok.slice(eq + 1);
      } else {
        name = tok.slice(2);
        if (i + 1 >= rest.length || rest[i + 1].startsWith('--')) return { error: `旗标 --${name} 缺值` };
        value = rest[i + 1];
        i += 1;
      }
      if (!allowed.includes(name)) return { error: `未知旗标：--${name}` };
      if (name === 'impact') (flags.impact ??= []).push(value);
      else flags[name] = value;
    } else {
      extra.push(tok);
    }
  }
  if (extra.length > 0) return { error: `多余参数：${extra.join(' ')}` };
  return { flags };
}

function dispatch(argv, root) {
  const [cmd, ...rest] = argv;
  const allowed = CMD_FLAGS[cmd];
  if (!allowed) return usageExit2(`未知子命令：${cmd ?? '(空)'}`);
  const parsed = parseArgs(rest, allowed);
  if (parsed.error) return usageExit2(parsed.error);
  const flags = parsed.flags;
  if (cmd === 'init') {
    if (!flags['task-id'] || !flags.profile) return usageExit2('init 须 --task-id 与 --profile');
    const profile = loadJson(pathArg(flags.profile));
    const r = createChange(root, flags['task-id'], profile);
    emit(r);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'status') {
    if (!flags.change) return usageExit2('status 须 --change');
    const r = readStatus(root, flags.change);
    emit(r);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'advance') {
    if (!flags.change || !flags.to) return usageExit2('advance 须 --change 与 --to');
    // E02（内部任务-241）：参数 JSON 非法属工具/参数错误（退 2），与 cli.mjs 同类参数一致；
    // 旧实现直接 SyntaxError 落 catch→isValueError→退 1，把调用错误误报成内容阻断。
    let evidence;
    try {
      evidence = JSON.parse(flags.evidence ?? '[]');
    } catch (e) {
      return usageExit2(`--evidence 不是合法 JSON：${e.message}`);
    }
    let notApplicable = null;
    if (flags['not-applicable'] !== undefined) {
      try {
        notApplicable = JSON.parse(flags['not-applicable']);
      } catch (e) {
        return usageExit2(`--not-applicable 不是合法 JSON：${e.message}`);
      }
    }
    const r = storeAdvance(root, flags.change, flags.to, evidence, {
      taskId: flags['task-id'] ?? null,
      commitSha: flags['commit-sha'] ?? '',
      artifactDigest: flags['artifact-digest'] ?? null,
      environment: flags.environment ?? 'development',
      notApplicable,
      incidentRef: flags['incident-ref'] ?? null,
    });
    emit(r);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'assess') {
    if (!flags.change || !flags.claim || !flags.context) return usageExit2('assess 须 --change --claim --context');
    const CLAIMS = ['code-complete', 'merge-ready', 'production-ready', 'production-accepted'];
    if (!CLAIMS.includes(flags.claim)) return usageExit2(`--claim 须为 ${CLAIMS.join('|')} 之一`);
    const profilePath = join(root, '.sdd', 'delivery-profile.json');
    // 原 Python 实现（迁移史见 内部决策-051） `profile_path.is_file()`：缺失/目录→null；存在但坏 JSON→ValueError→1（门① B4）
    const profile = isFile(profilePath) ? loadJson(profilePath) : null;
    const changeCtx = loadJson(pathArg(flags.context));
    const reported = changeCtx.gateStates ?? {};
    const impacts = flags.impact ?? []; // --impact 可重复（parseArgs 收集）
    const crossDiags = [];
    if (profile) {
      const requirements = resolveRequirements(profile, impacts);
      for (const [domain, want] of Object.entries(requirements)) {
        const got = reported[domain];
        if (got == null) continue; // 缺域由 assessClaim 的 DOMAIN-MISSING 兜底（原 Python 实现（迁移史见 内部决策-051） production.py:100-101）
        // 原 Python 实现（迁移史见 内部决策-051） `got.get("mode") != want["mode"]`：缺 mode 得 None、同样判漂移（门① B1）
        if ((got.mode ?? null) !== want.mode) {
          crossDiags.push({ ruleId: 'PROD-CLAIM-MODE-DRIFT', severity: 'blocking', gate: domain,
            message: `域 ${domain} 自报 mode=${got.mode} 与 policy 推导 mode=${want.mode} 不一致（推导依据：${want.reason ?? ''}）——禁止手写 context 覆盖 profile 推导` });
        }
      }
    }
    const ctx = { ...changeCtx };
    if (!Object.hasOwn(ctx, 'changeId')) ctx.changeId = flags.change; // 原 Python 实现（迁移史见 内部决策-051） setdefault（门① N7）
    const verdict = assessClaim(profile, flags.claim, reported, ctx);
    verdict.diagnostics = [...(verdict.diagnostics ?? []), ...crossDiags];
    if (crossDiags.length > 0) verdict.status = 'blocked';
    emit(verdict);
    return verdict.status === 'passed' ? 0 : verdict.status === 'config-error' ? 2 : 1;
  }
  if (cmd === 'recover') {
    if (!flags.change) return usageExit2('recover 须 --change');
    const r = storeRecover(root, flags.change);
    emit(r);
    return r.ok ? 0 : 1;
  }
}

if (INVOKED_DIRECTLY) {
  // E01（内部任务-241）：写 stdout 后立即 process.exit 会截断管道输出；改用 exitCode 等自然刷新。
  process.exitCode = main(process.argv.slice(2));
}
