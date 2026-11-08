// 文件：stdio.mjs
// 描述：live stdio 适配器（内部规则-2 / 内部接口-17 / 内部决策-015）——子进程以参数数组执行
//       （禁 shell 拼接）；capability 握手；超时与输出上限；不可用记 unverified
//       不伪装 passed。本模块接收的是「可执行脚本路径或内联代码」，不做网络调用。
//       2026-10-29 内部任务-253（三维评审收敛）：**只返回 transport 元数据＋原始 parsed**，不合成任何信封
//       （plan F2；此前 `envelope` 零消费者且非合规形态已删除）。调用方（agent-eval live）先按
//       transport 分流、再对 `parsed` 走 validateEnvelope。`availability/result` 是本层 transport
//       结果摘要（可用性/状态语义），不是 内部接口-1 信封。
// 作者：wangp  创建：2026-09-13  版权：MIT（见 team-governance/LICENSE）
import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';

/**
 * 运行 stdio 适配器。
 * @param {string} script 被测脚本路径（node 可执行）；或内联代码（自动经 -e 执行）
 * @param {{capability: string, timeoutMs?: number, maxOutputBytes?: number, payload?: object}} req
 * @returns {Promise<{transport: 'ok'|'spawn-error'|'timeout'|'overflow'|'unparseable'|'nonzero-exit',
 *   exitCode: number|null, stdoutText: string, stderrText: string, startedAt: number, finishedAt: number,
 *   command: string, durationMs: number, parsed?: object,
 *   availability: 'available'|'unavailable'|'degraded', result: {status: string, summary: string}}>}
 */
export async function runStdioAdapter(script, req) {
  const timeoutMs = req.timeoutMs ?? 15000;
  const maxOutputBytes = req.maxOutputBytes ?? 1 << 20;
  // 单行且形如路径才按脚本文件执行；多行/含语句分隔的内联代码一律走 -e（Windows 反斜杠路径不误判）
  const looksLikePath = !script.includes('\n')
    && (script.endsWith('.mjs') || script.endsWith('.js') || script.includes('/') || script.includes('\\') || isAbsolute(script));
  const useInline = !looksLikePath;
  const argv = useInline ? ['-e', script] : [script];
  const handshake = JSON.stringify({ schemaVersion: '1.0.0', capability: req.capability, ...(req.payload ?? {}) });
  const startedAt = Date.now();
  const t0 = performance.now();
  const command = useInline ? `${process.execPath} -e <inline>` : `${process.execPath} ${script}`;

  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { stdio: ['pipe', 'pipe', 'pipe'] }); // 参数数组：禁 shell 拼接；execPath 不依赖 PATH 解析（内部非功能需求-1）
    /** @type {Buffer[]} */
    const chunks = [];
    /** @type {Buffer[]} */
    const errChunks = [];
    let total = 0;
    let stderrBytes = 0;
    let timedOut = false;
    // 内部任务-257（P5-7）：超时/输出超限 SIGKILL 后 close 可能永不触发（孙进程持管道）——kill 后宽限强 settle。
    const STDIO_GRACE_MS = 300;
    let settled = false;
    let graceTimer = null;
    const done = (partial) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      try { child.stdout?.destroy(); } catch { /* noop */ }
      try { child.stderr?.destroy(); } catch { /* noop */ }
      try { child.stdin?.destroy(); } catch { /* noop */ }
      const finishedAt = Date.now();
      resolve({
        startedAt,
        command,
        stdoutText: Buffer.concat(chunks).toString('utf8'),
        stderrText: Buffer.concat(errChunks).toString('utf8'),
        finishedAt,
        durationMs: Math.round((performance.now() - t0) * 10) / 10,
        ...partial,
      });
    };
    const fail = (transport, availability, summary) => done({ transport, exitCode: null, availability, result: { status: 'unverified', summary } });
    const killAndArmGrace = (kind = 'timeout') => {
      // 只 arm 一次：超限后孙进程持续写 stdout 时，重复 arm 会让 300ms 宽限无限续期（三维评审修复）
      if (settled || graceTimer) return;
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      graceTimer = setTimeout(() => (kind === 'overflow'
        ? fail('overflow', 'degraded', `输出超限（>${maxOutputBytes}B；kill 后宽限 ${STDIO_GRACE_MS}ms 仍无 close）`)
        : fail('timeout', 'unavailable', `超时（>${timeoutMs}ms；kill 后宽限 ${STDIO_GRACE_MS}ms 仍无 close）`)), STDIO_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killAndArmGrace();
    }, timeoutMs);

    child.stdout.on('data', (c) => {
      total += c.length;
      if (total <= maxOutputBytes) chunks.push(c);
      else killAndArmGrace('overflow'); // 输出超限：终止并宽限 settle（防日志炸弹＋防挂起）
    });
    child.stderr.on('data', (c) => {
      // stderr 同样受输出上限约束（防日志炸弹；只保留前 maxOutputBytes 字节）
      if (stderrBytes < maxOutputBytes) { errChunks.push(c); stderrBytes += c.length; }
    });
    child.on('error', () => {
      fail('spawn-error', 'unavailable', `进程启动失败：${req.capability}`);
    });
    child.on('close', (code) => {
      if (settled) return;
      if (timedOut) return fail('timeout', 'unavailable', `超时（>${timeoutMs}ms）`);
      if (total > maxOutputBytes) return fail('overflow', 'degraded', `输出超限（>${maxOutputBytes}B）`);
      if (code !== 0) return done({ transport: 'nonzero-exit', exitCode: code, availability: 'unavailable', result: { status: 'unverified', summary: `适配器退出码 ${code}` } });
      const text = Buffer.concat(chunks).toString('utf8').trim();
      try {
        const parsed = JSON.parse(text.split('\n').pop() ?? '{}');
        // 不在本层短路 capability：parsed 原样返回，由调用方 decide（信封合法性/握手/单一源）
        const capOk = parsed.capability === undefined || parsed.capability === req.capability;
        const avail = parsed.status === 'unavailable' || !capOk ? 'unavailable' : 'available';
        const resultStatus = avail === 'unavailable' ? 'unverified' : (parsed.status ?? 'unverified');
        done({ transport: 'ok', exitCode: code, parsed, availability: avail, result: { status: resultStatus, summary: parsed.summary ?? (capOk ? '' : '能力不匹配') } });
      } catch {
        done({ transport: 'unparseable', exitCode: code, availability: 'degraded', result: { status: 'unverified', summary: '适配器输出不可解析（须末行 JSON）' } });
      }
    });
    child.stdin.write(handshake + '\n');
    child.stdin.end();
  });
}
