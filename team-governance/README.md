# AI Coding 方法论 · 团队治理（team-governance）

团队级 AI Coding 治理插件（可选安装）：AI Run Manifest、模型策略、上下文信任、Change Set / CAS Lease、内容绑定审批、replay-first Agent Eval 与治理报告。

- **做什么**：把「谁能用哪个模型改哪块代码、谁批的、凭哪份证据」变成可审计的事实——受治理的 AI 开发有 run 记录与政策预检，变更范围与审批内容绑定（对象一变审批即失效），完成经治理报告聚合出口出证。
- **何时用**：团队/多开发者环境需要统一模型策略、协作互斥（租约）与审计追溯时安装；单人项目可不装，其余五插件不受影响。
- **限制**：本地登记的审批恒为「本地作证」，不冒充第三方身份核验；宿主不可观察的模型/token/身份如实记 `unavailable`——严格策略下这是拒绝，不是猜测。

决策记录与契约（维护者深读）：`内部规格 ADR 目录`（治理系列）与 `内部规格 内部接口-2`。

## 环境要求

受支持宿主之一（原生形态＝ZCode 约定，SessionStart / PreToolUse 事件；DSH / MCode / Kimi Code 经对应适配层接入，事件映射与降级见各适配层 README）+ Node.js ≥ 21（与根 README 单源口径一致，内部未决-15 裁决）；零第三方包（仅 Node 内置）。

## 安装

ZCode 插件约定：`.zcode-plugin/plugin.json`。放入 marketplace 或本地插件目录后启用；未安装时 workflow 路由表治理行会给安装指引（普通开发路由不受影响）。AI Coding 方法论六件套之一（可选安装，内部决策-012..015；统一版本发布 内部决策-017）。

## 快速开始

```bash
TG=<本插件安装根>/scripts/governance-cli.mjs
node $TG --project-root <项目根> init        # 幂等接入（已有配置不覆写；播种内联默认政策）
node $TG --project-root <项目根> check --contexts-file <contexts.json>
                                             # 政策 preflight + 上下文诊断（读归一后政策：strict 遇模型不可观察 deny，relaxed warning；
                                             # --contexts-file 必填：JSON 数组、每项 {source,trust,...}；无 contexts 退 2 不空转）
node $TG --project-root <项目根> gate         # 出治理报告（唯一聚合出口；含 binding/sources/coverage）
node <本插件安装根>/scripts/agent-eval.mjs --selftest   # 评测 CLI 冒烟
```

## 政策、审批与中止（操作事实）

- **run 生命周期（内部任务-254）**：`run-begin` 的 `--initiator` 落 manifest `humanInitiator`，`policy.riskLevel=high` 时**必填**（缺失/旗标当值退 2）；stdout 含 `openHash`。`--host <zcode|dsh|mcode|kimi|unknown>` 显式声明审计宿主（缺省按环境探测，未知 `unknown`，不冒充 zcode；内部任务-256）。`run-finalize --expect-hash sha256:<openHash>` 为 CAS（open manifest 被外部改动即退 2）；finalized manifest 记 `policyDigest`/`changeSetDigest`，最近 completed 与当前绑定不符 → gate `TG-MANIFEST-STALE` 阻断（更旧/cancelled/failed/legacy 仅 warning）；finalized 后再 finalize 退 2（不可重开）。
- **政策**在 `.ai-governance/config.json` 的内联 `policy`（权威源；`enforcement: strict|relaxed`）。改严格度后 `check`/`run-begin` 裁决随之改变：strict 且模型不可观察 → `check` 退 1、`run-begin` 拒开且**不落 run 文件**；relaxed → warning 留痕继续。旧顶层 `policyId`/`policyVersion`/`enforcement` 字段仍兼容读取（归一为 legacy 默认，不固定 relaxed）；与内联同轴不一致时工具错退 2。
- **change-set** 落 `.ai-governance/runtime/change-set.json`（digest 重算校验；缺字段/resources 非字符串等语义坏件 → gate `TG-ASSET-INVALID` 阻断，不得当「无锚」通过）；**approve** 审批原子落 `.ai-governance/runtime/approvals/approvals.jsonl` 并绑定**当前 subject**（内容+政策+change-set+审批 profile+eval 套件的组合摘要——对象变即失效）。`--subject-digest` 仅一致性断言（与当前现算不一致退 1）；本地登记恒 `local-attested`；`--identity` 必填且须可归属（非空且非 `unknown`——匿名审批不构成有效独立审批、不满足 approvals 必填、不解除自批阻断）；`--expires-at` 缺省 2099-01-01，给定须真实 `YYYY-MM-DD`（非法退 2）。
- **审批折叠与阻断（内部任务-254）**：gate 按 `approvalId` 折叠（数组序后者覆盖；带 `revocation` 的记录覆盖并视为撤销）；`validUntil` 只取折叠后**有效**审批的最早 `expiresAt`；阻断单源＝`requiredDomains` 含 `approvals` 且无有效审批 → `TG-APPROVAL-MISSING` blocking；历史失效仅 `TG-APPROVAL-INVALID` warning；`riskLevel=high` 时自批 → `TG-APPROVAL-SELF` blocking（无有效独立审批时），无归属（requestedBy 缺失/unknown）→ `TG-APPROVAL-UNATTRIBUTED` warning。
- **eval 报告复核（内部任务-254）**：gate 复核 eval 报告 `integrityHash`——篡改/缺失/空/不可复算均 `TG-EVAL-TAMPERED` blocking（fail-closed）；agent-eval 的 suite/case 形态非法（空 cases/缺字段/未知 oracle kind/SchemaError）一律工具错退 2、不产报告。
- **租约前端护栏（显式启用）**：PreToolUse 便利护栏默认关闭（防打扰）——在 `.ai-governance/config.json` 显式写 `"leaseEnforcement": true` 后，命中受控资源前缀且存在 held 租约冲突时**注入 unverified 提醒、仍 allow 不 deny**（团队强制点仍在 CI/gate）。
- **落盘脱敏（内部任务-255）**：`gate` 写 `runtime/reports/governance-report.json` 前必经 `lib/redaction.mjs` 脱敏并在脱敏后重算 `integrityHash`（stdout 摘要同口径）；`learning-note` 的 observed 落盘与输出、`agent-eval --mode replay` 的权威报告同批脱敏；脱敏后残余命中或结构节（binding/sources/coverage）命中秘密 → 拒绝写入、工具错退 2。
- **gate 报告**含 `binding`（subject/validUntil）、`sources`（按路径排序的控制输入清单+缺失标记）、`coverage`（逐域 loaded|empty|missing|invalid）。此后项目内容/政策/审批/控制输入任一变化，旧报告即 `stale`（重跑 `gate` 刷新）；手改报告= `tampered`。`validUntil` 取采用的有效审批最早 `expiresAt`，时间到界报告过期。
- **中止受治理 run**：`run-finalize --outcome cancelled --reason "<可审计理由>"`（`failed` 同理；缺省 `completed`）。manifest `status` 仍 `finalized` 且不可变——取消如实封存、不冒充成功；如持有租约，用 `lease release --lease-id <id> --revision <n>` 释放（审计记录保留）。
- **eval 报告**默认权威落 `.ai-governance/runtime/evals/`（gate 实际读取该目录）；`--out` 只是导出副本，不自动成为权威输入（登记须走 config `evalReportFiles`）。

命令实例（`TG` 同「快速开始」）：

```bash
# 改严格度：编辑 .ai-governance/config.json 的 policy.enforcement（strict|relaxed），裁决随之改变
echo '[{"source":"repo:仓库维护说明","trust":"repository"}]' > /tmp/tg-contexts.json
node $TG --project-root <项目根> check --contexts-file /tmp/tg-contexts.json   # strict 且模型不可观察 → 退 1；relaxed → warning 留痕继续

# 内容绑定审批（绑当前 subject：内容/政策/change-set/审批 profile/eval 套件任一变化即失效）
node $TG --project-root <项目根> approve --role accountable --identity alice --expires-at 2026-10-20

# 中止受治理 run（诚实封存：status=finalized 且不可变、取消不冒充成功；cancelled/failed 必填 reason）
node $TG --project-root <项目根> run-finalize --run-id <id> --repo-head <sha> --diff-digest <sha> \
  --outcome cancelled --reason "需求变更，本 run 不再推进"
node $TG --project-root <项目根> run-finalize --run-id <id> --repo-head <sha> --diff-digest <sha> \
  --outcome failed --reason "验证无法收敛（两个假设证伪），转根因调试"

# 如持有租约，一并释放（审计记录保留，不自动删除）
node $TG --project-root <项目根> lease release --lease-id <id> --revision <n>
```

## 诚实降级（内部接口-2）

模型/token/身份在宿主不可观察 → manifest 写 `unavailable`（strict 策略 deny，宽松策略 warning）；live 评测不可用记 `unverified` 不伪装 passed；指标只做过程/系统维度（按人分组键被拒绝——非绩效红线）。

## 目录

- `scripts/lib/`——核心库（canonical-json/schema 子集/redaction/run-manifest/policy/context-trust/change-set/lease/approval/eval/governance-gate/governance-store/learning）
- `scripts/adapters/`——contract（中立信封）/stdio（live eval）/github-ci（warning-only）/github-live（受控只读 API）/github-pr（dry-run）/git-ref-lease（跨开发者 CAS）/os-observe（os-observation 只读面，2026-09-19 顺手补滞后缺失的 github-live）
- `skills/`——team-governance（元技能）、agent-eval（评测）
- `hooks/`——SessionStart 治理摘要 + PreToolUse 租约护栏（均 fail-open）
- `core/schemas/`——adapter_envelope.schema.json

## 测试

```bash
node --test "team-governance/scripts/tests/*.test.mjs"
node team-governance/hooks/session-start.mjs --selftest && node team-governance/hooks/pre-tool-use.mjs --selftest
```

项目侧资产分层：`.ai-governance/config.json` 为内联政策权威源（含 `policy` 与显式 `evalSuiteFiles` 清单，可配置）；runtime/（runs/leases/reports/evals/approvals）为本地运行态，不冒充跨机事实。**内部任务-256 现状回写**：policies/eval-suites 目录版本化加载面未实现（承接 内部未决-220）。
