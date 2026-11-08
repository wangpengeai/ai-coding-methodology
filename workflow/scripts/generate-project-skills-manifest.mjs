// 文件：workflow/scripts/generate-project-skills-manifest.mjs
// 描述：项目级 skill 清单的 designated generator（内部决策-070 D2，内部任务-341）。默认 --check
//       只读逐字节比对；--apply 原子写 项目级技能（tmp+rename、写后读回、
//       输出条目级 diff），失败非零且不落半写。生成面扫描固定五根；运行时消费按当前宿主过滤。
// 作者：内部任务-341 批
// 版权：MIT
// 用法：node workflow/scripts/generate-project-skills-manifest.mjs [--check|--apply] [--project-root <dir>]

import { existsSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

import {
  MANIFEST_REL,
  buildManifest,
  renderManifest,
} from './lib/project-skills.mjs';

/** 解析 CLI 参数（不接受未知参数，避免误写）。 */
export function parseArgs(argv) {
  const opts = { mode: 'check', projectRoot: process.cwd(), errors: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') opts.mode = 'check';
    else if (arg === '--apply') opts.mode = 'apply';
    else if (arg === '--project-root') {
      const value = argv[i + 1];
      if (!value) opts.errors.push('--project-root 缺值');
      else {
        opts.projectRoot = value;
        i += 1;
      }
    } else opts.errors.push(`未知参数：${arg}`);
  }
  return opts;
}

/** 计算旧/新文本并给出条目级 diff（用于 --apply 与失败诊断）。 */
export function diffManifest(oldText, newText) {
  const parse = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  const before = parse(oldText ?? '') ?? { skills: [] };
  const after = parse(newText) ?? { skills: [] };
  const keyOf = (s) => `${s.name}@${s.root}`;
  const oldMap = new Map((before.skills ?? []).map((s) => [keyOf(s), s]));
  const newMap = new Map((after.skills ?? []).map((s) => [keyOf(s), s]));
  const added = [...newMap.keys()].filter((k) => !oldMap.has(k));
  const removed = [...oldMap.keys()].filter((k) => !newMap.has(k));
  const changed = [...newMap.keys()].filter((k) => oldMap.has(k) && JSON.stringify(oldMap.get(k)) !== JSON.stringify(newMap.get(k)));
  return { added, removed, changed };
}

function run(argv) {
  const opts = parseArgs(argv);
  if (opts.errors.length > 0) {
    process.stderr.write(`${opts.errors.join('\n')}\n`);
    return 1;
  }
  const { manifest, errors } = buildManifest({ projectRoot: opts.projectRoot });
  if (errors.length > 0) {
    process.stderr.write(`清单生成失败：\n${errors.join('\n')}\n`);
    return 1;
  }
  const rendered = renderManifest(manifest);
  const abs = join(opts.projectRoot, MANIFEST_REL);
  const oldText = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
  const drift = diffManifest(oldText, rendered);
  const changed = oldText !== rendered;

  if (opts.mode === 'check') {
    const result = { ok: !changed, mode: 'check', path: MANIFEST_REL, skills: manifest.skills.length, drift };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return changed ? 1 : 0;
  }

  if (!changed) {
    process.stdout.write(`${JSON.stringify({ ok: true, mode: 'apply', path: MANIFEST_REL, skills: manifest.skills.length, drift, wrote: false })}\n`);
    return 0;
  }
  const tmp = `${abs}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, rendered, 'utf8');
    renameSync(tmp, abs);
    const readBack = readFileSync(abs, 'utf8');
    if (readBack !== rendered) throw new Error('写后读回不一致');
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // 清理失败不掩盖原错误
    }
    process.stderr.write(`清单写入失败（未落半写）：${error.message}\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify({ ok: true, mode: 'apply', path: MANIFEST_REL, skills: manifest.skills.length, drift, wrote: true })}\n`);
  return 0;
}

const invokedDirectly = (() => {
  try {
    if (!process.argv[1]) return false;
    if (import.meta.url === pathToFileURL(process.argv[1]).href) return true;
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.exitCode = run(process.argv.slice(2));
}
