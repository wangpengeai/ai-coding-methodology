// 文件：pre-tool-use.mjs
// 描述：team-governance PreToolUse 便利护栏（内部规则-6 / 内部需求-1 / NFR-tg-ci / 内部验收-22）——
//       仅在「项目显式启用 + 配置可解析 + 目标资源明确命中受控路径前缀 + 存在有效
//       held 租约」四条件同时成立时输出 unverified 提醒并放行（exit 0）：本地护栏
//       无可信调用者/持有者证明，不执行身份裁决——own/foreign 持租约未能可信区分时
//       同属 unverified，不 deny、不要求合法持有者先 release、不伪造 --holder/env
//       认证、不宣称跨开发者锁或 CI 强制；真实互斥强制由租约库 CAS 与 CI 承载
//       （内部接口-15 §3）。路径匹配为前缀边界匹配（沿 lease 库口径，取消 substring
//       粗匹配）；未命中/过期静默；任何内部异常 fail-open 退 0（本地是提醒层）。
// 用法：宿主经 hooks.json 以 process 方式调用（stdin=宿主 JSON 负载）；--selftest 冒烟。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { familyOf } from '../scripts/lib/tool-families.mjs';

const ENFORCING_CONFIG_KEY = 'leaseEnforcement'; // 显式启用开关（防默认打扰）

function projectRoot() {
  return process.env.ZCODE_PROJECT_DIR || process.env.QODER_CWD || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function loadEnforcement(root) {
  const configPath = join(root, '.ai-governance', 'config.json');
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

function loadHeldLeases(root) {
  const path = join(root, '.ai-governance', 'runtime', 'leases', 'leases.json');
  if (!existsSync(path)) return [];
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    return Object.values(state.leases ?? {}).filter((l) => l.state === 'held' && l.expiresAt >= Date.now());
  } catch {
    return [];
  }
}

/**
 * 前缀边界匹配（沿 lease 库 pathsOverlap 的 path 语义）：受控目录是目标文件的祖先
 * 目录（相等或 target 位于 prefix + 分隔符之下）才算命中——substring 粗匹配会把
 * src-x 误判进 src（2026-09-13 首版缺陷，内部任务-5 C 修正）。
 */
function pathPrefixHit(root, resourcePrefix, target) {
  const absPrefix = resolve(root, resourcePrefix);
  const absTarget = resolve(target);
  return absTarget === absPrefix || absTarget.startsWith(absPrefix + sep);
}

/**
 * 净化进入 systemMessage 的文本（内部规则-6 / 内部任务-255 N-2）：剔除全部 C0/C1 控制字符与 bidi 控制
 * （含换行/ANSI），保留普通空白并对超长文本加省略号——防止 target/资源/持有者文本污染宿主消息面。
 * @param {unknown} v
 * @param {number} [maxLen]
 * @returns {string}
 */
function sanitizeText(v, maxLen = 200) {
  const s = String(v).replace(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, '');
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

function run() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0); // 负载不可解析：fail-open
  }
  const root = projectRoot();
  const config = loadEnforcement(root);
  if (!config || config[ENFORCING_CONFIG_KEY] !== true) process.exit(0); // 未显式启用
  const tool = payload?.tool_name;
  // 内部任务-59（内部未决-84）：工具族判定取代 ZCode 字面量比对——DSH/MCode 的原生名是小写
  // （edit/write/pwsh/bash），旧形态在本插件的这两宿主上恒退 0（护栏空转）；族白名单外
  // 一律静默放行（fail-open 姿态与旧形态同向）。
  if (familyOf(tool) !== 'edit') process.exit(0); // 非 agent 写路径不拦
  const target = payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path ?? null;
  if (typeof target !== 'string' || !target) process.exit(0); // 目标资源不可判定：不猜（非字符串真值亦 fail-open）
  const held = loadHeldLeases(root);
  const hit = held.find((l) => {
    if (!String(l.resource).startsWith('path:')) return false;
    const prefix = l.resource.replace(/^path:[^:]+:/, '').replace(/\/\*\*$/, '');
    return pathPrefixHit(root, prefix, target);
  });
  if (!hit) process.exit(0); // 无冲突租约
  // unverified 提醒并放行：本地未执行身份裁决，强制点在 CI/gate（内部规则-6 扩义）
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      systemMessage: `[team-governance][unverified] 路径 ${sanitizeText(target)} 落在租约 ${sanitizeText(hit.resource)}（持有者 ${sanitizeText(hit.holder)}，fencing=${sanitizeText(hit.fencingToken, 32)}）覆盖范围内。本地护栏未执行调用者身份裁决（无法可信区分是否同一持有者）——本提醒不阻断写入；如非预期，请与持有者协调后经 governance-cli lease release 释放；真实互斥强制点在 CI/gate（IF-COLLAB-15）。`,
    },
  }) + '\n');
  process.exit(0);
}

/** 顶层兜底：任何内部异常 fail-open 退 0（本地是提醒层，内部规则-6 / 内部验收-22）。 */
function main() {
  try {
    run();
  } catch {
    process.exit(0);
  }
}

if (process.argv.includes('--selftest')) {
  // 内部任务-5 C（内部规则-6 扩义/内部验收-22）：重写为 unverified 语义断言——命中受控路径
  // 只提醒不 deny（无可信调用者证明时本地不执行身份裁决）；前缀边界匹配（取消
  // substring 粗匹配，沿 lease 库口径）；过期/未命中静默；垃圾负载 fail-open。
  const checks = [];
  const check = (name, cond) => checks.push([name, Boolean(cond)]);
  const home = mkdtempSync(join(tmpdir(), 'tg-pretool-selftest-'));
  const me = fileURLToPath(import.meta.url);
  try {
    mkdirSync(join(home, '.ai-governance'), { recursive: true });
    mkdirSync(join(home, '.ai-governance', 'runtime', 'leases'), { recursive: true });
    mkdirSync(join(home, 'src'), { recursive: true });
    mkdirSync(join(home, 'ctl'), { recursive: true });
    writeFileSync(join(home, '.ai-governance', 'config.json'), JSON.stringify({ leaseEnforcement: true }), 'utf8');
    // held 租约（lease.mjs 落盘形态）：path:main:src/** 受控、未过期；另加一把已过期的 docs 租约
    const leaseState = {
      schemaVersion: '1.0.0',
      revision: 2,
      leases: {
        'lease-selftest01': {
          leaseId: 'lease-selftest01', resource: 'path:main:src/**', holder: 'run-st',
          changeSetId: null, backend: 'local', scope: 'workspace-local', state: 'held',
          acquiredAt: Date.now(), expiresAt: Date.now() + 60_000, revision: 1, fencingToken: 1,
        },
        'lease-selftest03': {
          leaseId: 'lease-selftest03', resource: 'path:main:ctl/**', holder: 'run\u001b[31m-st',
          changeSetId: null, backend: 'local', scope: 'workspace-local', state: 'held',
          acquiredAt: Date.now(), expiresAt: Date.now() + 60_000, revision: 3, fencingToken: 1,
        },
        'lease-selftest02': {
          leaseId: 'lease-selftest02', resource: 'path:main:docs/**', holder: 'run-old',
          changeSetId: null, backend: 'local', scope: 'workspace-local', state: 'held',
          acquiredAt: Date.now() - 120_000, expiresAt: Date.now() - 60_000, revision: 2, fencingToken: 1,
        },
      },
    };
    writeFileSync(join(home, '.ai-governance', 'runtime', 'leases', 'leases.json'), JSON.stringify(leaseState), 'utf8');
    const run = (payload) => {
      const r = spawnSync(process.execPath, [me], {
        input: typeof payload === 'string' ? payload : JSON.stringify(payload),
        encoding: 'utf8', env: { ...process.env, ZCODE_PROJECT_DIR: home },
      });
      return { status: r.status, stdout: r.stdout ?? '' };
    };
    const hit = run({ tool_name: 'Edit', tool_input: { file_path: join(home, 'src', 'a.ts') } });
    const env = hit.status === 0 ? (() => { try { return JSON.parse(hit.stdout); } catch { return null; } })() : null;
    check('命中受控路径 unverified 提醒(0) 不 deny', hit.status === 0 && env !== null);
    check('信封 hookEventName=PreToolUse', env?.hookSpecificOutput?.hookEventName === 'PreToolUse');
    check('permissionDecision 非 deny', env?.hookSpecificOutput?.permissionDecision === 'allow');
    check('文案说明本地未执行身份裁决', String(env?.hookSpecificOutput?.systemMessage ?? '').includes('身份'));
    check('文案指明强制点在 CI/gate', String(env?.hookSpecificOutput?.systemMessage ?? '').includes('CI'));
    check('文案不要求持有者先 release', !String(env?.hookSpecificOutput?.systemMessage ?? '').includes('先释放'));
    check('文案点名租约持有者（信息保留）', String(env?.hookSpecificOutput?.systemMessage ?? '').includes('run-st'));
    // 内部任务-59（内部未决-84）小写宿主工具名（DSH/MCode 原生形态）同族命中判据：改动前应为 RED
    // （钩体以 'Edit'/'Write'/'Bash' 三字面量比对，小写名恒退 0 零输出）。
    const lowerEdit = run({ tool_name: 'edit', tool_input: { file_path: join(home, 'src', 'a.ts') } });
    check('小写 edit 命中受控路径（DSH/MCode 形态）', lowerEdit.status === 0 && lowerEdit.stdout.trim() !== '');
    const lowerWrite = run({ tool_name: 'write', tool_input: { file_path: join(home, 'src', 'b.ts') } });
    check('小写 write 命中受控路径（DSH/MCode 形态）', lowerWrite.status === 0 && lowerWrite.stdout.trim() !== '');
    // shell 族（pwsh/bash）本就不入本护栏面：族白名单姿态下应静默（此为负例边界，改动前后均绿）
    const shellLower = run({ tool_name: 'pwsh', tool_input: { file_path: join(home, 'src', 'c.ts') } });
    check('pwsh（shell 族）静默(0) 零输出', shellLower.status === 0 && shellLower.stdout.trim() === '');
    const readTool = run({ tool_name: 'read', tool_input: { file_path: join(home, 'src', 'a.ts') } });
    check('read（非写面）静默(0) 零输出', readTool.status === 0 && readTool.stdout.trim() === '');
    // 兄弟前缀：src-x 不是 src 的子路径（substring 粗匹配会误命中——回归锚）
    const sibling = run({ tool_name: 'Edit', tool_input: { file_path: join(home, 'src-x', 'a.ts') } });
    check('兄弟前缀不误命中（边界匹配）静默(0)', sibling.status === 0 && sibling.stdout.trim() === '');
    const outside = run({ tool_name: 'Edit', tool_input: { file_path: join(home, 'other', 'b.md') } });
    check('界外资源静默(0) 零输出', outside.status === 0 && outside.stdout.trim() === '');
    const expired = run({ tool_name: 'Edit', tool_input: { file_path: join(home, 'docs', 'b.md') } });
    check('过期租约静默(0)', expired.status === 0 && expired.stdout.trim() === '');
    const garbage = run('not-json {{{');
    check('负载垃圾 fail-open(0)', garbage.status === 0 && garbage.stdout.trim() === '');
    // 内部任务-255（N-2）：顶层 fail-open ＋ systemMessage 控制字符净化
    const nonString = run({ tool_name: 'Edit', tool_input: { file_path: 123 } });
    check('非字符串 file_path 退 0 零输出（顶层 fail-open）', nonString.status === 0 && nonString.stdout.trim() === '');
    const ctlTarget = run({ tool_name: 'Edit', tool_input: { file_path: join(home, 'src', 'a\nb\u001b[31m\u202A.ts') } });
    const ctlEnv = (() => { try { return JSON.parse(ctlTarget.stdout); } catch { return null; } })();
    check('target 控制字符净化（systemMessage 无 ESC/换行）', ctlTarget.status === 0 && ctlEnv !== null
      && !/[\u0000-\u001f\u001b\u202A-\u202E\u2066-\u2069]/u.test(String(ctlEnv?.hookSpecificOutput?.systemMessage ?? '')));
    const ctlHolder = run({ tool_name: 'Edit', tool_input: { file_path: join(home, 'ctl', 'x.ts') } });
    const holderEnv = (() => { try { return JSON.parse(ctlHolder.stdout); } catch { return null; } })();
    check('holder 控制字符净化（systemMessage 无 ESC）', ctlHolder.status === 0 && holderEnv !== null
      && !String(holderEnv?.hookSpecificOutput?.systemMessage ?? '').includes('\u001b'));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const failed = checks.filter(([, ok]) => !ok);
  for (const [name, ok] of checks) process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}\n`);
  process.exit(failed.length ? 1 : 0);
}

main();
