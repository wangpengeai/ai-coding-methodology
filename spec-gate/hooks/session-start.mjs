#!/usr/bin/env node
// 文件：spec-gate/hooks/session-start.mjs
// 描述：SDD 台账 SessionStart 提醒 hook（提醒为主，永不阻断；见下方 JSDoc）。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
/**
 * sdd-methodology SessionStart hook（提醒为主，永不阻断）。
 *
 * 读取项目 内部治理状态，汇总：超期未收敛任务（RULE-LEDGER-002）、
 * blocking 未决项、项目级 opt-out 命中；无台账/解析失败一律静默退出 0。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

function projectDir() {
  return process.env.ZCODE_PROJECT_DIR || process.env.QODER_CWD || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function suppressedScopes(optOuts, now) {
  const covered = { all: ["all", "sdd", "ddd", "ddd-strategic", "tdd"], ddd: ["ddd", "ddd-strategic"] };
  const suppressed = new Set();
  for (const record of optOuts || []) {
    if (record.mode === "current-task") continue;
    if (record.expiresAt && Date.parse(record.expiresAt) <= now) continue;
    // S05/E04（内部任务-241）：scope 是台账不可信输入——只认自有键，未知 scope 原样压下（原型键不得取到
    // Object.prototype 的不可迭代值而 TypeError，进而在 fail-open 里静默丢全部提醒）。
    const scopes = Object.prototype.hasOwnProperty.call(covered, record.scope)
      ? covered[record.scope]
      : [record.scope];
    for (const scope of scopes) suppressed.add(scope);
  }
  return suppressed;
}

async function main() {
  await readStdin();
  const ledgerPath = path.join(projectDir(), ".sdd", "ledger.json");
  const ledger = readJson(ledgerPath);
  if (!ledger) return;

  const now = Date.now();
  const lines = [];

  const overdue = (ledger.tasks || []).filter((task) => {
    if (!task.deadline) return false;
    if (!["active", "temporary-mitigation"].includes(task.status)) return false;
    const deadline = Date.parse(task.deadline);
    return Number.isFinite(deadline) && deadline <= now;
  });
  if (overdue.length > 0) {
    lines.push("【SDD 台账】以下快速通道任务已超期未收敛，按 RULE-LEDGER-002 阻塞非紧急变更，直至定稿（「阻塞」指 SDD 台账口径的任务收敛纪律——超期任务的定稿与收敛优先；不改变其他提醒或护栏的既有行为，各护栏姿态见各自规则）：");
    for (const task of overdue) {
      lines.push(`- ${task.id} ${task.title}（deadline: ${task.deadline}，负责人: ${task.owner || "未登记"}）`);
    }
  }

  const blockingOpen = (ledger.openItems || []).filter(
    (item) => item.blocking && item.status === "open"
  );
  if (blockingOpen.length > 0) {
    lines.push("【SDD 台账】以下未决项为阻塞性，不得进入基线定稿：");
    for (const item of blockingOpen) {
      lines.push(`- ${item.id} ${item.impact}（收敛触发: ${item.resolutionTrigger}）`);
    }
  }

  const suppressed = suppressedScopes(ledger.optOuts, now);
  if (suppressed.size > 0) {
    lines.push(`【SDD 台账】项目级 opt-out 命中范围: ${[...suppressed].join(", ")}（本次显式要求时可覆盖）`);
  }

  if (lines.length === 0) return;

  const output = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: lines.join("\n"),
    },
  };
  process.stdout.write(JSON.stringify(output));
  // E01（内部任务-241）：写 stdout 后不得立即 process.exit（管道下会截断信封）；用 exitCode。
  process.exitCode = 0;
}

/** 自检（内部模块-09/内部任务-241 步骤20）：≥3 条断言覆盖 opt-out 归并/原型键防崩/过期过滤（失败退 1 可见）。 */
function selftest() {
  const now = Date.now();
  const checks = [];
  const check = (name, cond) => checks.push([name, Boolean(cond)]);

  const ddd = suppressedScopes([{ scope: "ddd" }], now);
  check("opt-out ddd 归并 ddd/ddd-strategic", ddd.has("ddd") && ddd.has("ddd-strategic"));
  const proto = suppressedScopes([{ scope: "__proto__" }, { scope: "toString" }], now);
  check("原型链 scope 不崩且原样压下", proto.has("__proto__") && proto.has("toString"));
  const expired = suppressedScopes([{ scope: "sdd", expiresAt: "2000-01-01T00:00:00Z" }], now);
  check("过期 opt-out 不生效", !expired.has("sdd"));

  for (const [name, ok] of checks) process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}\n`);
  const failed = checks.filter(([, ok]) => !ok).length;
  if (failed > 0) {
    process.stdout.write(`FAIL session-start.mjs selftest（${failed} 项未过）\n`);
    return 1;
  }
  process.stdout.write(`OK session-start.mjs selftest（${checks.length} 项通过）\n`);
  return 0;
}

if (process.argv.includes("--selftest")) {
  process.exitCode = selftest();
} else {
  main().catch(() => process.exit(0));
}
