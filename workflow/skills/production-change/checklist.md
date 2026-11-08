# production-change 操作核对单

> 本清单只消费 policy 输出与 内部接口-13 诊断（B-M10-3）——不复制 specialist 正文，不构成第二判定源。逐项核对来自 `resolveRequirements` 的域处置与 gate 诊断（JS 实现 `spec-gate/assurance/production_policy.mjs`；Python 时代名 `resolve_requirements` 已随零 Python 棘轮退役）。

## 交接装载

- [ ] taskId / base-head SHA 与凭据链任务一致
- [ ] PR refs / required checks 与证据信封 subject 一致（head SHA 逐字比对）
- [ ] delivery profile 存在且 digest 与 CHG 事件一致（无漂移）
- [ ] 凭据链 finalize 产物存在（code-complete 层）

## 逐域处置（按 gate 输出核对，不自行增删域）

- [ ] 每个 required 域：passed 证据引用齐备且在 evidenceMaxAgeHours 内
- [ ] 每个 not-applicable 域：结构化理由可核查（引用 profile 字段或 change impact）
- [ ] 每个 waived 域：五要素齐备（authority/scope/expiresAt/替代验证/残余风险）且未过期
- [ ] 底线项（不可豁免）：subject SHA / artifact digest / profileDigest 一致；无明文秘密；active Scout 模式下停止

## 外部副作用前

- [ ] 执行计划已呈现（环境/制品 digest/回滚命令）
- [ ] 用户明确授权（授权人已写入 change-context）
- [ ] 回滚命令经口头演练（可执行、恢复时间已知）

## 观测与验收

- [ ] 观测窗口时长与 SLI/SLO 按 profile 要求收集；越限即回滚遏制（不"再观察一下"）
- [ ] UAT 证据来自 acceptanceAuthority 对应主体、绑定当前 build
- [ ] 反馈只存引用；分诊去向回路由表

## claim 裁决

- [ ] 四层 claim 逐层裁决（不跳层取高）；退出码与诊断已逐条处置
