---
name: verification
description: 完成验证（证据先于断言）—— 触发条件：任何「完成/通过/修好了」类完成声明发出之前。
license: MIT
---

# verification：完成验证（证据先于断言）

铁律：没有本条消息内的验证输出，就没有完成声称（内部规则-5、B-M5-1）。「代码写完了」是行为描述，「验证过了」是证据结论——把前者变成后者的唯一途径，是真实运行验证命令并引用其输出；本 skill 就是这道闸。

## 适用场景

- 入口 skill：用户状态命中路由表「代码已写完，声称完成」行时进入；验证通过后按同一行流转 code-review（互斥规则 2，见接口节）。
- 裁决范围覆盖一切完成语义：不止"任务完成"，还包括"修好了""测试通过""能跑了""这块搞定了"以及任何暗示工作已就绪的表述——措辞变体不改变触发——操作型任务（ad-hoc 类）除外：其完成留痕为 verification + operation 凭据 + 操作记录（内部决策-023 操作链），不强制 code-review，但验证证据义务不减免。
- 与 tdd 的分工：tdd 在实现过程中随行落任务级 RED/GREEN 证据；本 skill 在完成声称前聚合这些证据、补齐缺口，裁决的是整体声称。执行期证据已覆盖的项复用而不重跑（见接口节）。
- 子代理参与的场合：子代理报告"完成"只是输入不是结论，同样要经本 skill 的证据核验。

## 流程

完成声称发出之前按序过闸，跳过任何一步，后续声称即无效。

### 第 1 步：确定验证命令

- 项目接入 `.sdd/` 体系（`内部治理状态` 存在）时，优先取其中登记的 validationCommands——登记是项目自己声明的"怎么算过"，不以现场判断覆盖。
- 未接入体系或登记缺失时，现场选定验证命令并说明理由：验证什么声称、为什么这条命令能证明它——声称测试通过就跑测试命令，声称构建成功就跑构建命令，测什么跑什么。
- 声称与命令对不上时先修正其一：要么收窄声称，要么换命令，不拿近似命令凑数。

### 第 2 步：本条消息内运行并读取输出

- 验证命令必须在当前这条消息内实际运行——上一条消息、上一个会话、"刚才"跑过的输出都已过期：其后的代码改动可能已经推翻它。
- 完整运行，不截断、不挑片段；读全输出：退出码、失败计数、警告。
- 输出与声称同现：引用关键行（退出码、通过/失败统计），而不是只说"通过了"。

### 第 3 步：按证据下结论

本步只产出**阶段结论**——「验证通过」或「未通过」（code-complete 层）：验证通过≠最终完成，最终完成声明在完成链链尾 finalize 之后才成立（见「最终完成链」）。

| 输出证实声称 | 输出未证实声称 |
|---|---|
| 带证据给出「验证通过」阶段结论：结论 + 命令 + 关键输出引用 | 如实报告实际状态：失败几处、差什么；不带"基本完成"这类折中措辞 |

声称前出现「应该能过」「之前跑过」「看起来没问题」即是未验证信号，回到第 2 步。

### 语义回收核验（U6 / 内部决策-058 决策 5，2026-10-23 内部任务-219）

凡本任务声称完成时含**删除/替换/退役类变更**（删文件、删接口、改语义、退役环境门/命令/字段），在给出第 3 步阶段结论前必须先执行本节核对语义回收三件套，缺一不给「验证通过」：

- **扫描零命中**：DSR（`scripts/check-repo-consistency.mjs` 第 23 块）按登记的 `scanScope`/`historicalScopes` 判定现行面 0 命中；不得临场缩根或行级豁免。
- **登记状态更新**：涉及的 open-items / feature-lifecycle / governance-registry / ADR 登记行与真实状态一致（关闭、改判或显式豁免均须留痕）。
- **证据指针**：回收动作的扫描输出、关账行变更或豁免理由已落入本消息可指的 evidence（内部接口-5 格式）。

### 第 4 步：证据落盘（内部接口-5）

本 skill 是证据生产方，格式契约的唯一来源是 内部接口-5：

- 每条验证记一条证据，要素：命令、工作目录、退出码、输出摘要、关联（ruleId 或 specId）。
- 前置：命令真实运行过，禁止凭记忆补录；退出码缺失或伪造，证据无效（blocking）。证据只列**已实际执行**的命令与已生成凭据；未执行步骤不得写成既成结果，命令/退出码/凭据 id 不得预写；「待收尾轮填写」占位不得进入证据正文（C5/内部任务-193）。
- 关联逐条必填：缺关联时消费方按契约报 warning（证据未关联规则或规格）。
- 敏感信息写入前脱敏（沿用 spec-gate capture 的脱敏规则）。
- 落点：项目有 `.sdd/` 体系时经 `/spec-gate:evidence -- <cmd>` 捕获，或按格式直接写入 `evidence.jsonl`；未接入时按同一格式记入任务记录。

### 完成声称三件套（与第 4 步证据并列的硬前置）

完成声称成立须三件俱全，缺一件声称不成立：①证据——第 4 步已落盘的本对象验证证据；②门禁——`.sdd/` 项目完成声称前已调用 spec-gate:gate skill（或用户键 `/spec-gate:gate`）跑聚合门禁，报告结论留存于交付记录；③评审去向——验证通过后按互斥规则 2 进入 code-review（评审先于最终完成声明；用户点名审查路径除外，见 code-review 受理核验）。姊妹插件的门禁覆盖证据的"实质产出"，不等于"走过本 skill"——两道闸口径不同，都过才算数。

**最终完成链**（内部决策-007 唯一时序）：verification 凭据 → code-review → prepare(partial) → gate → finalize——最终完成声明只挂在稳定 revision 完成链的链尾；本 skill 止于验证阶段结论与凭据签发，不产出最终完成声明。

### 凭据链签发（内部决策-007 / 内部接口-11 / 内部规则-10）

`.sdd/` 项目在证据落盘后签发 verification 凭据（档位 full；探路模式任务为 scout-repro 并附 mode 与产物处置）：

```bash
node <spec-gate 安装根>/assurance/cli.mjs --project-root <项目根> issue-verification \
  --task-id <任务号> --evidence-file <证据引用JSON> [--profile full|scout-repro] \
  [--scout-mode <mode> --scout-disposition <处置>]
```

- 凭据绑定 taskId + 当前 RevisionSet：此后源码/规格/计划任何变化都使本凭据失效，须重跑验证重签（评审修复改码即触发，内部规则-10）。
- 档位分工（内部接口-5 / 内部模块-9 内部规则-8）：full 档证据关联逐条必填（每条证据带 ruleId 或 specId 关联，缺关联由消费方按契约报 warning）；scout-repro 档按 内部模块-9 可复现凭据——可复现命令、退出码、输出摘要，并绑定 taskId/sourceRevision/mode/产物处置，不套用逐条关联必填；两档的验证真实性、脱敏与 Safety Floor 均不降级。
- code-review 受理会校验本凭据；本 skill 的验证输出只构成 **code-complete 层**结论，不得表述为 merge-ready/production-ready/production-accepted 等更高层声明（四层 claim 归 内部接口-13，由 production-change 流程逐层裁决）。
- 用户点名审计路径免 verification 前置，其凭据形态为 inspection-only，永不进入完成链。

### 操作型任务签发面（内部决策-023 操作链；内部决策-027 状态断言与分级）

零代码/配置对象变更的 ad-hoc 操作型任务（发布/装机/环境运维）完成留痕走操作链，verification 证据义务照常，第二环免 code-review 改签 operation 凭据。判据升级为**可机检状态断言**（内部决策-027，防操作者自证——0.3.8 坏装机全绿实证）：criteria 项可含 `probe` 只读探针，签发点只校验形态，**gate 实际执行回读世界状态**，失败阻断：

```bash
node <spec-gate 安装根>/assurance/cli.mjs --project-root <项目根> issue-operation \
  --task-id <任务号> --verification <verification凭据id> \
  --authorization-quote "<用户当轮指令引文（≥8字）>" --authorization-scope "<授权范围>" \
  --criteria-file <判据JSON [{criterion,evidenceRef,probe?}]> --rollback "<回滚>" \
  --boundary "<生效边界>" --record <操作记录文件路径（仓库相对）> \
  --risk-level <L1|L2，缺省 L2>
```

probe **八类型**（内部决策-030 v2 词表＋内部决策-048 第八类；2026-10-09 内部任务-20 C 批 F2 增 `jsonl-record-field-eq`——JSONL 多记录：逐行解析、按 `match` 取**末条**命中、`field` 与 `expect` **严格类型相等**、行须为 JSON 对象、坏行/形态非法 ⇒ 配置错（fail-loud）、**不支持 `ref`**；2026-10-16 内部任务-11 增 `host-app-present`）：`file-exists`（kind 可选 file/dir）、`file-sha256`（expect 64hex 或 sha256: 前缀）、`json-field-eq`（field 点号+[i] 路径；expect 字面量或 ref 双读——读另一文件字段作期望值，`refTransform:"last-segment"` 取路径末段，即 038 双读场景）、`dir-tree-hash`（目录树摘要，默认滤 __pycache__/.pyc/.mimosa）——此四类路径双基 project/user-home，禁绝对路径与 .. 穿越；`acl-state`（icacls DENY ACE 在位断言，Windows，path 双基）、`audit-policy-state`（auditpol Inclusion 空/非空断言，Windows，**无 path**，提权执行面探针——非提权恒 1314 fail-loud blocking，内部决策-030 背景 2）、`host-app-present`（宿主应用在位断言，**无 path**——按平台读共享签名库 `spec-gate/assurance/host-signatures.json` 候选、≥1 存在＝present；库不可读/平台键缺/候选列空 ⇒ 配置错 fail-loud（空列不造恒红探针）；expect `host∈{zcode,mcode,kimi,dsh}`/`presence∈{present,absent}` 双向——预装可断言 absent 留痕，内部决策-048）。两类外部状态探针均为代码内置命令模板、判据面零注入；命令缺失/超时 fail-loud。探针失败 `RULE-GATE-OPASSERT` blocking、坏探针 `RULE-GATE-OPASSERT-CONFIG` blocking，结果进 gate 报告 `operationAssertions` 节。

**风险分级（内部决策-027，正确性断言不分级，分级只调授权仪式）**：
- **L1 本地可逆**（缓存/注册表等有备份的本机状态操作）：必须携带 ≥1 个 probe（零探针 RULE-GATE-OPNOASSERTION 阻断）；gate 免授权复核 warning；**免 prepare/finalize 两阶段**——完成标记=gate 凭据 riskLevel L1 + 探针全过。
- **L2 不可逆/跨边界**（缺省 fail-safe）：probe 可选（本机可验证的状态建议补，零探针仅 warning）；授权引文由 gate 以 warning 原样呈现供人在环复核（RULE-GATE-OPAUTH 恒现）；照常 prepare→gate→finalize。

聚合门禁加 `--operation-chain` 旗标；既有无 riskLevel 字段的旧凭据按 legacy 读（不执行探针、授权 warning 保持，不追溯）。

### 制品型任务签发面（内部决策-023 修正案 2 / 内部未决-128 方案 B，内部任务-116）

制品型 ad-hoc 任务（声明名 `ad-hoc-deliverable`——PPT/文档/图表等一次性交付物）完成留痕走**制品链三环**：verification 证据 → 类型匹配评审凭据 → operation 凭据 → gate `--deliverable-chain`。评审环命令形态：

```bash
node <spec-gate 安装根>/assurance/cli.mjs --project-root <项目根> issue-code-review \
  --task-id <任务号> --verification <verification凭据id> \
  --review-instances <n≥1（渲染验收/内容审实例数）> --review-mode deliverable \
  --review-round <n（缺省 1）> --review-provenance '[{"role":"render-acceptance","instance":"<实例标识>","chain":"task:<任务号>","state":"fresh"}]' \
  --fix-review-mode none \
  --summary "<一句话结论（如：渲染验收 14/14 全过 / 内容审 1 发现已处置）>"
```

`--review-provenance` 须按实例逐条给出（共 n 条、与 `--review-instances` 的 countable（fresh|reused）数一致，`chain=task:<任务号>`）；示例只列 1 条，n>1 时照此复制并替换 role/instance。

制品链/豁免形态只允许 `--fix-review-mode none`（修复复审仅适用于代码评审环）；`--fix-review-mode` 是 CLI 必填参数。operation 环与状态型同形态（含探针判据与 L1/L2 分级）；收口 `gate --deliverable-chain`（与 `--operation-chain` argparse 互斥）。四因子校验（缺一即拒，防 dev 任务中途转链）：显式旗标 / 评审环 reviewMode=deliverable / 双环同引最新 verification / code-review 先于 operation 签发（createdAt）。混链拒绝语义相应修订：operation 与 code-review 并存仅在制品型序下合法，其余并存仍拒（内部决策-023 初衷不变——任务类型不可中途转换，转换须新任务号）。L1 免两阶段口径与状态型相同（制品链/操作链同口径，内部决策-027）；gate 报告双环并呈（operationAssertions + reviewRing，评审环恒现 RULE-GATE-DELIVREVIEW warning 人在环复核）。开发任务不得套用操作链或制品链逃避评审义务。

### 第 5 步：不可运行项豁免显式化

某项验证现实不可运行时（环境缺失、破坏性操作、耗时超限），不得静默跳过，逐条列出：哪一项没验证、为什么不可运行、不验证它剩余什么风险。豁免清单与完成声称一起呈现，缺口由用户看到后裁决；清单之外不得有"默认算过"的项。

### 反合理化表

| 念头 | 反驳 |
|---|---|
| "测试刚才都跑过了，不用再跑" | "刚才"的输出证明的是刚才的代码；本条消息内的改动之后，旧输出一文不值。重跑以秒计，带病声称的返工以小时计。 |
| "这个改动不影响测试" | 影响与否是验证结论，不是前提；拿"我认为不影响"当免跑理由，是用直觉冒充测试。影响面由跑出来的结果说了算。 |
| "编译通过等于验证通过" | 编译只证明语法与类型成立，证明不了行为正确；声称"功能完成"却只跑编译，是拿最低门槛的检查冒充最高门槛的结论。 |
| "手动看过了" | 手动验证无法复跑、没有记录、边界情况靠碰运气，是一次抽查不是证据；能自动化的跑命令，不能的走第 5 步显式豁免。 |
| "子代理报告说成功了" | 报告是转述不是证据；子代理的成功声明同样过第 2 步——查实际改动、跑实际命令。 |

## 与其他 skill 的接口

- learnings：正常收尾时提示记一条 learning（一句话 + 证据链接；允许显式说"无收获"跳过——跳过要出口，不沉默略过）。
- code-review（互斥规则 2）：本 skill 的验证证据未实际运行之前，code-review 不得开始（T-M5-1，路由表执行）；"代码已写完"不等于"已验证"，顺序不可颠倒，也不可并行。
- tdd：证据复用——执行期落盘的 RED/GREEN 证据按 内部接口-5 可被本 skill 直接引用，已覆盖项不重复生产；全量回归、构建、登记命令等缺口由本 skill 补齐运行与落盘。
- plan-execution：上游——全部任务完成后按路由表进入本 skill；任务内的每步验证归 plan-execution 检查点，本 skill 裁决整体完成声称。
- spec-gate：项目级聚合——项目接入 `.sdd/` 体系时，完成声称前先跑 `/spec-gate:gate` 聚合校验，门禁未过则完成声称不成立（workflow 元技能跨插件衔接）；证据捕获走 `/spec-gate:evidence`。
- 自察收口（内部决策-019）：完成声称前运行插件根 `scripts/incident-cli.mjs list`（当前会话注入的待排查指针行给出可直接复制的绝对路径），有 open 自察异常须先排查或显式 triage 留痕——带未排查异常的"完成"不是完成。

## 边界与禁止项

- **B-M5-1**：无验证输出不得声称完成——本 skill 核心禁令；无证据的完成声明即违规，措辞多确定都不豁免。
- 不做代码级评审：实现质量、设计问题、带置信度的意见清单归 code-review；本 skill 只回答"声称是否被证据支撑"。
- 不定义豁免类别：验证不可行的豁免记录规则归 spec-gate（与 RULE-TDD-005 同域语义），本 skill 只逐条列出原因与剩余风险，不私设"可以不验证"的情形。
- 不改代码：验证失败时的修复经路由表回实现场景（plan-execution 或 root-cause-debugging），本 skill 只产出结论与证据，不在验证流程里顺手改实现。
- 失败证据举一反三：失败证据暴露后、进入处置前，按元技能全局规则「自查举一反三」执行同类扫描（义务全文唯一载体在元技能，本条只做指针、不转述判据）；修复本身经路由表回实现场景。
