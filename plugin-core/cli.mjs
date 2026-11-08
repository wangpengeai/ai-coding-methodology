#!/usr/bin/env node
// 文件：plugin-core CLI
// 描述：materialize/verify 两子命令——中立清单物化与生成物漂移对拍；退码 0 全绿 / 1 校验失败、
//       漂移或写失败 / 2 用法错（含 --repo-root 不可访问）；预期内错误以单行 `[plugin-core] …` 输出、不抛栈。
// 作者：wangp 创建：2026-10-01  版权：MIT（见 workflow/LICENSE）
// 用法：node plugin-core/cli.mjs <materialize|verify> [--plugin <名>] [--repo-root <路径>]
// 自检：node --test "plugin-core/tests/verify.test.mjs"
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PLUGINS, planAll, applyPlan, verifyPlan } from './src/materialize.mjs';

const USAGE = [
  '用法：node plugin-core/cli.mjs <子命令> [旗标]',
  '  materialize  从中立清单物化 ZCode 形态生成物（.zcode-plugin/plugin.json 恒产；hooks 非空才产 hooks/hooks.json；整体覆写）',
  '  verify       只读对拍：重算物化输出与仓库生成物逐文件比较（ok/changed/missing/extra），漂移退 1',
  `旗标：--plugin <名>（缺省＝套件全部插件：${PLUGINS.join('/')}）  --repo-root <路径>（缺省当前目录）`,
  '示例：node plugin-core/cli.mjs verify',
].join('\n');

function isMain() {
  // 两轮比对（内部任务-GUARDSYML-1 先例）：首轮原始形态保留（兼容 --preserve-symlinks-main 下
  // import.meta.url 为别名形态的运行方式），第二轮 realpath 归一（darwin /var symlink 防击穿）
  try {
    if (import.meta.url === pathToFileURL(process.argv[1]).href) return true;
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const out = { sub: null, plugin: undefined, repoRoot: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const takeValue = (flag) => {
      const v = argv[++i];
      if (v === undefined) { console.error(`${flag} 缺值\n${USAGE}`); process.exit(2); }
      return v;
    };
    if (a === '--plugin') out.plugin = takeValue(a);
    else if (a === '--repo-root') out.repoRoot = takeValue(a);
    else if (out.sub === null && !a.startsWith('--')) out.sub = a;
    else { console.error(`未知参数: ${a}\n${USAGE}`); process.exit(2); }
  }
  return out;
}

function resolvePlugins(name) {
  if (name === undefined) return PLUGINS;
  if (!PLUGINS.includes(name)) {
    console.error(`未知插件名 ${name}，候选：${PLUGINS.join('/')}`);
    process.exit(2);
  }
  return [name];
}

function main() {
  const { sub, plugin, repoRoot } = parseArgs(process.argv.slice(2));
  // 子命令合法性先于任何文件系统访问（坏 --repo-root 不得抢占用法错的退码）
  if (sub !== 'materialize' && sub !== 'verify') {
    console.error(sub === null ? USAGE : `未知子命令: ${sub}\n${USAGE}`);
    return 2;
  }
  const plugins = resolvePlugins(plugin);
  let root;
  try {
    root = realpathSync(repoRoot);
  } catch {
    console.error(`仓库根不存在或不可访问: ${repoRoot}`);
    return 2;
  }
  try {
    if (sub === 'materialize') {
      const plan = planAll(root, plugins);
      applyPlan(plan);
      for (const { plugin: p, rel } of plan) console.log(`已生成 ${p}/${rel}`);
      return 0;
    }
    const results = verifyPlan(root, plugins);
    let drift = 0;
    for (const { plugin: p, rel, status } of results) {
      if (status === 'ok') console.log(`ok ${p}/${rel}`);
      else { drift++; console.error(`${status} ${p}/${rel}`); }
    }
    if (drift > 0) {
      console.error(`漂移 ${drift} 处——唯一编辑面为 <插件>/plugin.manifest.json；勿手改生成物，改后跑 node plugin-core/cli.mjs materialize`);
      return 1;
    }
    return 0;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // 契约：预期内错误以单行 `[plugin-core] …` 输出（planAll 的聚合错误自带换行，此处拍平为「；」）
    console.error(`[plugin-core] ${message.replace(/\s*\n\s*/g, '；')}`);
    return 1;
  }
}

if (isMain()) process.exitCode = main(); // 写 stdout 后不得立即 exit（管道截断；内部任务-241 纪律，内部任务-333 对齐 kimi 先例）
