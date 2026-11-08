#!/usr/bin/env node
// 文件：spec-gate/hooks/post-tool-use.mjs
// 描述：SDD 受检文档 PostToolUse 校验 hook（提醒为主；显式 block 档才阻断，见下方 JSDoc）。
// 作者：wangp  创建：2026-10-18  版权：MIT（见 spec-gate/LICENSE）
/**
 * sdd-methodology PostToolUse hook（Write|Edit）。
 *
 * 仅当被写文件命中项目套件配置声明的受检文档时运行校验器；
 * 诊断经 additionalContext 注入（提醒）；仅当用户配置
 * ZCODE_USER_CONFIG_SDD_HOOK_BLOCK=true 且存在 blocking 诊断时
 * 以退出码 2 阻断。任何异常一律静默退出 0（不阻断编码）；
 * 校验器不可用（缺失/自崩/输出污染）时 block 档 stderr 一行可见化提示后仍退 0
 * （H-7，内部任务-2 批：显式开启的阻断「未生效」必须被看见，默认提醒档维持静默）。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

function runValidator(suiteConfigPath) {
  // 测试缝（H-7）：SDD_TEST_VALIDATOR_BROKEN=1 时指向不存在的校验器——
  // 「校验器不可用 + block 开启」路径的判别力。
  const validator = process.env.SDD_TEST_VALIDATOR_BROKEN === "1"
    ? path.join(PLUGIN_ROOT, "core", "validator", "no-such-validator.mjs")
    : path.join(PLUGIN_ROOT, "core", "validator", "validate_specs.mjs");
  const validatorArgs = ["--config", suiteConfigPath, "--format", "json"];
  // 内部决策-051 阶段4：core 校验器为 Node 实现，直接以当前 node 执行；25s 内部预算低于宿主 30s。
  const r = spawnSync(process.execPath, [validator, ...validatorArgs], {
    encoding: "utf-8", timeout: 25000, stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error) return { report: null, failure: `校验器无法启动: ${r.error.message}` };
  const stderrTail = String(r.stderr ?? "").trim().split("\n").slice(-3).join(" / ").slice(0, 300);
  const code = typeof r.status === "number" ? r.status : null;
  let report;
  try {
    report = JSON.parse(String(r.stdout || ""));
  } catch {
    return { report: null, failure: `退出码 ${code ?? "未启动"} 但 stdout 非 JSON${stderrTail !== "" ? `（${stderrTail}）` : ""}` };
  }
  // 工具/配置错误（exit 2）不得被当成「报告已产出但无诊断」而静默放过；H-7 要让原因可见。
  if (code !== 0 && code !== 1) {
    const detail = report && typeof report.error === "string" ? report.error : (stderrTail || "无错误输出");
    return { report: null, failure: `退出码 ${code}：${String(detail).slice(0, 300)}` };
  }
  if (!report || typeof report !== "object" || !Array.isArray(report.diagnostics)) {
    return { report: null, failure: `退出码 ${code} 但报告缺 diagnostics${stderrTail !== "" ? `（${stderrTail}）` : ""}` };
  }
  return { report, failure: "" };
}

async function main() {
  const raw = await readStdin();
  let input = {};
  try {
    input = JSON.parse(raw || "{}");
  } catch {
    process.exit(0);
  }

  const filePath = input.tool_input && input.tool_input.file_path;
  if (!filePath) process.exit(0);

  const project = projectDir();
  const suiteRel = (() => {
    const projectConfig = readJson(path.join(project, ".sdd", "project.json"));
    return projectConfig ? projectConfig.suiteConfig || ".sdd/suite.json" : ".sdd/suite.json";
  })();
  const suitePath = path.isAbsolute(suiteRel) ? suiteRel : path.join(project, suiteRel);
  const suite = readJson(suitePath);
  if (!suite || !Array.isArray(suite.documents)) process.exit(0);

  const suiteRoot = path.resolve(path.dirname(suitePath), suite.suiteRoot || ".");
  const absoluteTarget = path.resolve(filePath);
  const declared = suite.documents.some((doc) => {
    const docPath = path.isAbsolute(doc.path) ? doc.path : path.resolve(suiteRoot, doc.path);
    return path.resolve(docPath) === absoluteTarget;
  });
  if (!declared) process.exit(0);

  // 校验器不可用（无解释器/校验器崩溃/输出污染——H-7）：默认档维持静默 fail-open（gate 兜底）；
  // 用户显式开启 SDD_HOOK_BLOCK 的阻断保护在此形态下结构性不可达，必须让「阻断未生效」被
  // 看见（内部未决-46「保护未生效零信号」同型），而非静默退 0。
  const blockEnabledEarly = String(process.env.ZCODE_USER_CONFIG_SDD_HOOK_BLOCK || "").toLowerCase() === "true";
  const { report, failure } = runValidator(suitePath);
  if (!report || !Array.isArray(report.diagnostics)) {
    if (blockEnabledEarly) {
      process.stderr.write(`【SDD 规格校验】校验器不可用（${failure}），SDD_HOOK_BLOCK 阻断本次未生效——请检查 Node/校验器安装后重跑\n`);
    }
    process.exit(0);
  }

  const relShown = path.relative(project, absoluteTarget) || absoluteTarget;
  const mine = report.diagnostics.filter((d) => {
    const dFile = path.resolve(path.dirname(suitePath), "..", d.file);
    return d.file === relShown || dFile === absoluteTarget || path.resolve(suiteRoot, d.file) === absoluteTarget;
  });
  if (mine.length === 0) process.exit(0);

  const blocking = mine.filter((d) => d.severity === "blocking");
  const lines = [`【SDD 规格校验】${relShown} 存在 ${mine.length} 条诊断：`];
  for (const d of mine.slice(0, 10)) {
    lines.push(`- ${d.ruleId} [${d.severity}] ${d.file}:${d.line} ${d.fixHint}`);
  }

  if (blockEnabledEarly && blocking.length > 0) {
    process.stderr.write(lines.join("\n") + "\n（已开启 SDD_HOOK_BLOCK：blocking 诊断阻断写入）");
    process.exit(2);
  }

  const output = {
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: lines.join("\n"),
    },
  };
  process.stdout.write(JSON.stringify(output));
  // E01（内部任务-241）：写 stdout 后不得立即 process.exit（管道下会截断信封）；用 exitCode。
  process.exitCode = 0;
}

if (process.argv.includes("--selftest")) {
  // 自检（2026-09-19 评审修复 H10，B-M8-4）：子进程驱动真实信封——本钩此前整文件零测试
  // 面与零 selftest（exit 2 阻断分支/三级解释器回退/诊断过滤全裸奔）。fixture 用真
  // 校验器跑（TODO 字面量触发文档级诊断），断言三态：命中注入/未命中静默/block 退 2。
  const checks = [];
  const check = (name, cond) => checks.push([name, Boolean(cond)]);
  const home = mkdtempSync(path.join(tmpdir(), "sg-posttool-selftest-"));
  const me = fileURLToPath(import.meta.url);
  try {
    mkdirSync(path.join(home, "specs"), { recursive: true });
    mkdirSync(path.join(home, ".sdd"), { recursive: true });
    writeFileSync(path.join(home, ".sdd", "suite.json"),
      JSON.stringify({ suiteRoot: "..", documents: [{ path: "specs/x.md" }] }), "utf8");
    writeFileSync(path.join(home, "specs", "x.md"), "# 夹具文档\n\n正文含 TODO 字面量（触发文档级诊断）\n", "utf8");
    const run = (payload, env = {}) => {
      const r = spawnSync(process.execPath, [me], {
        input: JSON.stringify(payload), encoding: "utf8",
        // 中性化宿主阻断配置（PHASE3 门 #2）：已开启 SDD_HOOK_BLOCK 的机器上 hit 态会被
        // block 分支截走退 2，selftest 假红——缺省空串，block 态再显式置 true
        env: { ...process.env, ZCODE_PROJECT_DIR: home, ZCODE_USER_CONFIG_SDD_HOOK_BLOCK: "", ...env },
      });
      return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    };
    const docPath = path.join(home, "specs", "x.md");
    const hit = run({ tool_name: "Write", tool_input: { file_path: docPath } });
    let env1 = null;
    try { env1 = JSON.parse(hit.stdout); } catch { /* 断言失败即红 */ }
    check("命中受检文档注入 PostToolUse 信封", hit.status === 0
      && env1?.hookSpecificOutput?.hookEventName === "PostToolUse"
      && String(env1.hookSpecificOutput.additionalContext ?? "").includes("诊断"));
    const miss = run({ tool_name: "Write", tool_input: { file_path: path.join(home, "not-declared.md") } });
    check("未声明文档静默（零输出退 0）", miss.status === 0 && miss.stdout.trim() === "");
    const blocked = run(
      { tool_name: "Write", tool_input: { file_path: docPath } },
      { ZCODE_USER_CONFIG_SDD_HOOK_BLOCK: "true" },
    );
    check("block 开启且 blocking 诊断 → 退 2", blocked.status === 2 && blocked.stderr.includes("SDD_HOOK_BLOCK"));
    // H-7（内部任务-2 批）：校验器不可用（env 缝指向不存在文件）+ block 开启 → fail-open 不阻断，
    // 但「阻断未生效」必须可见（stderr 一行），不得静默退 0。
    const broken = run(
      { tool_name: "Write", tool_input: { file_path: docPath } },
      { ZCODE_USER_CONFIG_SDD_HOOK_BLOCK: "true", SDD_TEST_VALIDATOR_BROKEN: "1" },
    );
    check("校验器不可用 + block 开启 → 退 0 但 stderr 提示阻断未生效", broken.status === 0
      && broken.stderr.includes("校验器不可用")
      && broken.stderr.includes("阻断本次未生效"));
    const brokenQuiet = run(
      { tool_name: "Write", tool_input: { file_path: docPath } },
      { ZCODE_USER_CONFIG_SDD_HOOK_BLOCK: "", SDD_TEST_VALIDATOR_BROKEN: "1" },
    );
    check("校验器不可用 + 默认提醒档 → 静默退 0（gate 兜底，不加噪）", brokenQuiet.status === 0 && brokenQuiet.stderr.trim() === "");
    // 工具/配置错误（validator 退 2 + {"error"}）：失败原因与退出码必须进入可见提示。
    writeFileSync(path.join(home, ".sdd", "suite.json"),
      JSON.stringify({ suiteRoot: "..", documents: [{ path: "specs/x.md" }], implementationNoiseTerms: "bad" }), "utf8");
    const toolError = run(
      { tool_name: "Write", tool_input: { file_path: docPath } },
      { ZCODE_USER_CONFIG_SDD_HOOK_BLOCK: "true" },
    );
    check("校验器工具错误 + block 开启 → 退 0 且提示含退出码与原因", toolError.status === 0
      && toolError.stderr.includes("校验器不可用")
      && toolError.stderr.includes("退出码 2")
      && toolError.stderr.includes("implementationNoiseTerms"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const failed = checks.filter(([, ok]) => !ok);
  for (const [name, ok] of checks) process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}\n`);
  if (failed.length > 0) {
    process.stdout.write(`FAIL post-tool-use.mjs selftest（${failed.length} 项未过）\n`);
    process.exit(1);
  }
  process.stdout.write(`OK post-tool-use.mjs selftest（${checks.length} 项通过）\n`);
  process.exit(0);
}

main().catch(() => process.exit(0));
