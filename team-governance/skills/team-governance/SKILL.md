---
name: team-governance
description: 团队 AI 治理元技能：AI Run Manifest、模型策略 preflight、上下文信任登记、Change Set/租约、审批与治理报告的接入与操作入口（确定性 CLI 是权威，本 skill 只编排与解释诊断） —— 触发条件：用户显式要求接入/运行团队 AI 治理、模型策略、审批或租约操作（workflow 路由表治理行命中后进入；插件未安装时输出安装指引）。
license: MIT
---

# team-governance：团队 AI 治理元技能

把"哪个 AI、读了什么、用什么权限、由谁批准、能否重放"变成可校验记录。**确定性 validator 是权威**——治理判断由 CLI/脚本裁决，本 skill 只编排命令与解释诊断，不自行裁断政策（内部决策-012）。

## 适用场景

- 用户显式要求接入治理（`init`）、发起受治理 run、建 change set、取/放租约、登记审批、出治理报告。
- 不适用：普通编码任务（不二次路由）；规格/完成门禁（归 spec-gate，只消费治理报告）。

## 操作入口（`$TG`＝`node <team-governance 安装根>/scripts/governance-cli.mjs`；下文命令以 `node $TG ...` 记）

```bash
TG=<team-governance 安装根>/scripts/governance-cli.mjs
node $TG --project-root <项目根> init                        # 幂等接入（已有配置不覆写；播种内联默认政策）
node $TG --project-root <项目根> check --contexts-file <contexts.json>
                                                             # 政策 preflight + 上下文诊断（读归一后政策，非硬编码默认；
                                                             # --contexts-file 必填——数组、每项 {source,trust,digest?,retrievedAt?}，无 contexts 退 2）
node $TG --project-root <项目根> run-begin --task-id <域前缀任务号> [--policy p1] [--initiator <id>] [--host <zcode|dsh|mcode|kimi|unknown>]
                                                             # 开启受治理 run（preflight deny/violation 拒开且零 run 文件；
                                                             # riskLevel=high 时 --initiator 必填、旗标当值退 2；stdout 含 openHash）
node $TG --project-root <项目根> run-finalize --run-id <id> --repo-head <sha> --diff-digest <sha> \
  [--outcome completed|cancelled|failed] [--reason "<理由>"] [--expect-hash sha256:<openHash>]
                                                             # outcome 缺省 completed；cancelled/failed 必填 reason（诚实封存）；
                                                             # --expect-hash 为 run-begin 的 openHash，不符退 2（CAS）；finalized 后再 finalize 退 2（不可重开）；finalize 记 policy/change-set digest
node $TG --project-root <项目根> change-set --repos main [--resources path:main:src/**]  # 落 runtime/change-set.json（digest 重算校验）
node $TG --project-root <项目根> lease acquire --resource path:main:src/** --holder <runId>
node $TG --project-root <项目根> lease release --lease-id <id> --revision <n>
node $TG --project-root <项目根> approve [--subject-digest <当前subject>] --role accountable --identity <id> [--expires-at YYYY-MM-DD]
                                                             # 审批原子落 runtime/approvals/approvals.jsonl，绑定当前 subject；
                                                             # --identity 必填且须可归属（非 unknown；匿名审批不构成有效独立审批）；
                                                             # --expires-at 缺省 2099-01-01，给定须真实 YYYY-MM-DD（非法退 2）
node $TG --project-root <项目根> gate                        # 出治理报告（唯一聚合出口；含 binding/sources/coverage）
node $TG --project-root <项目根> learning-note --statement "<一句话经验>" --incident <自察异常 id> [--owner <owner>]  # 自察异常沉淀为 observed 态 learning（内部模块-15）
```

退出码：0=通过；1=内容/政策阻断（逐条处置诊断）；2=工具/参数/配置错误。

### 政策与中止（操作事实）

- 政策在 `.ai-governance/config.json` 内联 `policy`（权威源）。改 `enforcement: strict` 后 `check`/`run-begin` 裁决随之改变（strict + 模型不可观察 → deny，`run-begin` 不落 run 文件）；relaxed → warning 继续。旧顶层 `policyId`/`enforcement` 字段兼容读取但不与内联冲突。
- 审批绑定**当前 subject**（内容+政策+change-set+审批 profile+eval 套件组合摘要）——对象变即失效，须重新审批；`--subject-digest` 与当前现算不一致时退 1（不接受过期快照）。
- 取消/失败受治理 run：`run-finalize --outcome cancelled --reason "<理由>"`——manifest `status` 仍 `finalized`（不可变），取消如实呈现、不冒充成功；如持有租约，经 `lease release` 释放（审计保留）。
- 租约前端护栏默认关闭（防打扰）：`.ai-governance/config.json` 显式写 `"leaseEnforcement": true` 后，PreToolUse 命中受控资源前缀且存在 held 租约冲突时**注入 unverified 提醒、仍 allow 不 deny**（团队强制点仍在 CI/gate）。
- `gate`：报告落盘/输出前脱敏（`lib/redaction.mjs`）并在脱敏后重算 `integrityHash`；脱敏后残余命中或结构节（binding/sources/coverage）命中秘密 → 拒写退 2。此后项目内容/政策/审批/控制输入变化，旧报告判 `stale`（重跑 `gate` 刷新）；报告手改判 `tampered`；`validUntil`（采用审批最早 `expiresAt`）到界报告过期。

## OS 外发观测（os-observe，内部决策-029；Windows/Linux/macOS 已实测）

<!-- lint:allow(skill-host-term) 内部规则-9/10 规格登记的 ZCode 宿主部署面锚（os-observe 用户级数据目录），非滥用 -->
OS 级外发观测为**用户级**能力（`~/.zcode/os-observe/`，不依赖 `--project-root`）：调度采样（win32=schtasks 计划任务、linux=crontab、darwin=launchd LaunchAgent 用户域周期+会话机会式补位兜底——内部任务-66）按 N 分钟口径采样 TCP 连接表与 DNS 缓存（DNS 面 win32/linux；darwin 非提权无域名可见面不提供——内部任务-66 关闭） → 三态分类（allowed/suspicious/unknown）→ `findings.jsonl`（追加折叠、脱敏白名单：只存域名/IP/进程名/时间）→ SessionStart hook 浮现未确认可疑项（默认只显示计数与下列命令指针；端点明细须 config `surfaceDetail:true` 显式开启）。

```bash
node $TG os-observe install [--poll-minutes 5]   # 安装采集（幂等；部署采样器到稳定路径；win32/linux/darwin 注册周期调度——darwin=launchd LaunchAgent，机会式补位兜底）
node $TG os-observe status                       # 采集在装/新鲜度/发现计数（只读）
node $TG os-observe list [--class suspicious] [--status open]   # 列出发现（折叠视图）
node $TG os-observe ack <id|前缀≥4> [--note "<一句话>"]          # 确认可疑发现（≠信任，不自动进允许清单）
node $TG os-observe report                       # 出 内部接口-1 信封（只读判定面）
node $TG os-observe uninstall                    # 对称移除调度（win32 计划任务/linux crontab/darwin LaunchAgent；findings/config 保留，不销账）
node $TG os-observe allow <pattern|id|前缀≥4>      # 加白名单（写 config.allow；域名 glob(*)/IP/CIDR）
node $TG os-observe deny <pattern|id|前缀≥4>       # 加用户可疑（写 config.suspicious；同 allow 参形态）
node $TG os-observe sysmon-guide                 # win-sysmon 扩展位启用引导（四要素+步骤，只读）
node $TG os-observe sysmon-enable                # 下载→签名核验记账→UAC 提权装驱动+注册采集任务（重登后生效）
node $TG os-observe sysmon-disable               # 移除 Sysmon 采集计划任务（驱动卸载属用户决策面）
node $TG os-observe dns-guide                    # linux-dns-tcpdump 扩展位启用引导（只读，不代装）
node $TG os-observe dns-enable                   # 包校验+sha256 记账→sudo 写 root crontab 保活+用户 crontab 转换器
node $TG os-observe dns-disable                  # 移除 DNS 保活/转换器条目并停监听进程（spool/provenance 不销账）
```

<!-- lint:allow(skill-host-term) 内部规则-9/10 规格登记的 ZCode 宿主部署面锚（os-observe 用户级配置文件），非滥用 -->
要点：未实测平台显式 `unavailable`（不提供未实测命令；win32/linux/darwin 已实测入列——darwin 载体=launchd LaunchAgent 周期+机会式补位兜底，用户登出期间「观测停滞」为真实语义）；用户自配在 `~/.zcode/os-observe/config.json`（allow/suspicious 模式数组、pollMinutes、surfaceDetail），install 播种不覆写既有配置；观测数据不出本机（不进治理报告与 Run Manifest 拉取面，B-M14-6）；「观测停滞」从句=raw 最新样本超 max(2×pollMinutes,30) 分钟，指示采集器疑似失效。

## 诚实降级（内部接口-2 / NFR-tg-degrade）

- 模型/token/身份不可观察 → manifest 写 `unavailable`，不估算；strict 策略遇不可观察模型 deny，宽松策略 warning+残余风险。
- 上下文七级信任：untrusted/external-unverified 只作 data 不作 instruction；高风险 run 拒无 digest 远程内容。
- 可复现性四档：exact 须精确模型版本+全 digest；只有 alias 最高 bounded。

## 边界与禁止项

- 不保存完整 prompt/秘密/私有源码（只存引用+哈希+受控摘要；落盘前 redact）。
- 指标只做过程/系统维度；按人分组的请求会被 metrics 拒绝（非绩效红线，内部需求-14）。
- 本地 hook 是提醒（fail-open）；团队强制点是 CI/PR check 与 spec-gate gate 的 governance 节（内部接口-18）。
- 不定义场景判定——治理操作的进入由 workflow 路由表治理行唯一判定（B-M1-1 同族）。
