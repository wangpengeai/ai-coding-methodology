---
name: agent-eval
description: Agent 行为评测：replay 优先（离线确定性 oracle 七族，CI 默认）、live stdio 显式 opt-in，报告绑定 case-set 与当前 skill/agent/prompt 哈希 —— 触发条件：用户要求评测 skill/agent 行为、发布前回归、或 CI 治理检查时。
license: MIT
---

# agent-eval：Agent 行为评测

回答"模型和提示词升级后质量是否真的没有退化"。评测结论由确定性 oracle 裁决；judge 只能补充解释，不能覆盖确定性失败（B-M14-2）。


## live 评测交付契约（内部任务-253，内部接口-17 / 内部验收-25）

- 触发：显式 `--live-adapter <脚本路径或内联代码>`；suite.cases 必须非空（空套件＝工具错误退 2，不产报告）。
- 适配器契约：结果对象为 内部接口-1 信封（含 `result.status/summary`，可选 `result.results:[{caseId,status,reason?}]` 逐 case 结果）；返回合法结果时**必须 exit 0**。capability 握手：信封 capability 必须等于请求值 `agent-eval`（合法枚举但不符→unverified 退 1；非法枚举→invalid_envelope 退 2）。
- transport 分流：spawn 失败/超时/输出超限/输出不可解析 → `unverified` 报告退 1；非零退出 → 工具错误退 2（只写 error manifest，不写 report/transcript）；信封非法 → 工具错误退 2（只写 error manifest）。
- 判定单一源：退 0 当且仅当 `availability=available` ∧ `result.status=passed` ∧ `summary.failed=0` ∧ `summary.unverified=0`；否则 failed/unverified 退 1；adapter status 与其自报 results 矛盾 → 工具错误退 2（fail-closed）。
- 权威落盘：`report`（mode:"live"）、`run manifest`、`transcript.jsonl` 三件落 `.ai-governance/runtime/evals/<suiteId>-live-<stamp>*`；**落盘前必经 `scanSecrets`+`redact`，脱敏后算 transcriptDigest/integrityHash**；脱敏后残余命中即拒写退 2（replay 落盘报告同口径：内部任务-255 H12）。
- 报告字段：`failureKind`（adapter_spawn_error/timeout/output_overflow/unparseable_output/invalid_envelope/secret_redaction_failure/status_mismatch/adapter_nonzero_exit/capability_mismatch）与 detail 承载可读失败原因；`availability` 与 `adapterStatus` 落盘供审计复算；`latencyMs` 为真实 wall-clock 测量。
- gate 语义：live 为 opt-in 证据，**不改变 gate 判定口径**（gate 只认 replay；缺 `mode` 的报告按 replay 处理）。

## 适用场景

- skill/agent/prompt 修改后的行为回归（replay：离线、无网、无凭据）。
- 发布门证据（eval report 绑定当前对象哈希；不匹配即 unverified）。
- live 评测（stdio adapter 显式 opt-in；不可用记 unverified 不伪装 passed）。

## 操作入口

```bash
node <team-governance 安装根>/scripts/agent-eval.mjs --project-root <项目根> \
  --suite <suite.json> --subject-hash <当前对象哈希> [--live-adapter <cmd>]
```

suite 形态（cases 数组；每 case 含 subjectHash/events/oracles/judgeNote）：

```json
{ "suiteId": "s1", "caseSetVersion": "v1", "cases": [
  { "caseId": "c1", "subjectHash": "sha256:…", "events": [{"text": "…"}],
    "oracles": [{"kind": "behavior", "required": ["查路由表"], "forbidden": ["跳过验证"]}] } ] }
```

oracle 七族：exact / regex / json-schema / behavior（required+forbidden）/ tool-event / exit-code / file-diff。

## 边界与禁止项

- judge 不覆盖确定性失败；同模型自评须显式标记，不得称独立评审。
- duration 真实测量；token/cost 无来源记 unavailable（不估字符数）。
- live 缺席是 unverified，不是 passed，也不是行为失败（退出码按成因 1/2）。
