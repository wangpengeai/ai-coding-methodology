// 文件：os-observe-cron.mjs
// 描述：os-observation Linux 调度面 crontab 工具（内部任务-OBSO-LINUX-1，内部规则-11，内部决策-029
//       决策 6）——读（exit 1 且空输出=无 crontab 合法空基线）/写（spawn stdin 通道，
//       参数数组无 shell 拼接）/标记块过滤（marker 注释行与其后紧邻的配对命令行）。
//       argv0 形态支持 ['crontab']（用户面/已 root 直跑）与 ['sudo','-n','crontab']
//       （root 面）。平台专有名（crontab）仅存本文件与 adapter 文件区（内部接口-1
//       §3 os-observe-* lib 子族界内）。spawnFn 注入缝供测试。
// 作者：wangp  创建：2026-09-20  版权：MIT（见 team-governance/LICENSE）
import { spawnSync } from 'node:child_process';

/** linux 轮询周期合法集：60 的因子（cron 分钟字段无法表达任意周期，如实限制不装假）。
 *  载体归本文件（调度面常量）：tasks（install 校验）与 dns adapter（dnsEnable 校验）两方消费，
 *  防 lib↔adapter 互 import 成环（阶段门 B delta D2 处置）。 */
export const LINUX_POLL_SET = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60];

/** 读 crontab：exit 0=有表；exit 1 且空输出=无 crontab（合法空基线）；其余=失败。 */
export function readCrontab({ spawnFn, argv0 }) {
  const r = spawnFn(argv0[0], [...argv0.slice(1), '-l'], { stdio: 'pipe' });
  if (r && r.status === 0) return { ok: true, text: String(r.stdout ?? '') };
  if (r && r.status === 1 && !String(r.stdout ?? '').trim()) return { ok: true, text: '' };
  return { ok: false };
}

/** 写 crontab（stdin 通道）；透传 spawn 结果（调用方经 writeFailWhy 拼诊断——失败面 stderr 可见）。 */
export function writeCrontab({ spawnFn, argv0, text }) {
  return spawnFn(argv0[0], [...argv0.slice(1), '-'], { stdio: 'pipe', input: text });
}

/** crontab 写失败的诊断从句（spawn error / exit+stderr 两形态——收尾评审简洁性 2 处置：四处复制收敛单点）。 */
export function writeFailWhy(w) {
  return w?.error
    ? `（spawn error ${w.error.code}）`
    : `（exit ${w?.status ?? '?'}）：${String(w?.stderr ?? '').trim()}`;
}

/** sh 单引号转义（cron 命令段路径加引——含空格路径防分词静默空转）。 */
export function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** 移除 marker 行与其后紧邻的配对命令行（下一行非空且不以 # 开头才吃掉——防误删用户注释）。 */
export function filterCronBlock(text, marker) {
  const lines = String(text).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === marker) {
      if (lines[i + 1] && lines[i + 1].trim() !== '' && !lines[i + 1].startsWith('#')) i += 1;
      continue;
    }
    out.push(lines[i]);
  }
  return out.join('\n');
}

/** 确保文本以单个换行结尾（追加块前拼接用）。 */
export function ensureNl(text) {
  return text === '' || text.endsWith('\n') ? text : `${text}\n`;
}
