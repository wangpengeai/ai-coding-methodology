# AI Coding 方法论 · 探路（scout）—— 探路插件

为探索性项目与一次性交付物提供项目级低纪律档位（ZCode 插件）：模式声明 + 到期检查点三选一（毕业/续期/放弃）+ 毕业移交。**纪律可以轻，安全与数据完整性底线不降级**。与工作流/规格门禁/团队治理/算法迭代/研究环（research-loop）组成完整方法论，配套使用。

- **做什么**：给「不值得建全套规格体系」的工作一个诚实的档位——声明探路模式（探索验证或一次性交付）后，证据义务降为可复现记录，到期检查点强制你三选一收敛，毕业时把成果移交回常规流程。
- **何时用**：技术探针、原型、一次性脚本/交付物；任务仍处常规开发时应留在 `workflow` 的场景档位内。
- **限制**：探路不是免检——安全底线（见下）在任何模式下不可降级；到期不收敛的任务会被检查点持续提醒。

## 本地自治与安全底线

- **本地自治**：模式生命周期（开启/续期/放弃/恢复）由本插件在项目本地以事务完成（锁 + 日志 + 单文件原子写）；`.scout/mode.json` 是唯一权威声明，有效性就地自含判定（合法且未过期即有效）。`spec-gate` 的中央登记只是**可选增强桥**——登记缺席不影响本地模式生效；**补登承诺**：登记失败仅留本地 `pendingSync`（本地权威不反转），桥可用后运行 `sync` 补登；桥不可用从不阻塞开发。
- **安全底线**：任何探路模式下默认禁止生产凭据与生产数据（默认用合成/脱敏数据）、部署与共享分支写入、不可逆外部副作用；网络与外部写须显式授权；临时凭据/数据须有清理或撤销证据。测试面可以降级，安全、隐私与数据完整性**不随档位降级**。

## 环境要求

受支持宿主之一（原生形态＝ZCode 约定，SessionStart 事件；DSH / MCode / Kimi Code 经对应适配层接入，事件映射与降级见各适配层 README）+ Node.js ≥ 21；零第三方包（仅 Node 内置）。

## 安装

ZCode 中将本目录注册为插件（`.zcode-plugin/plugin.json` 约定式加载）。AI Coding 方法论六件套之一：核心件 workflow，配套 spec-gate / team-governance / algo-loop / research-loop（可选）；套件统一版本发布（内部决策-017）。

启用后验证：在探路模式项目中新开会话，观察到期检查点注入（SessionStart）；完整装机首验清单见 内部冒烟检查单（不随源码公开）。

## Skills（3）

| skill | 触发条件 |
|---|---|
| `scout` | 需要开关探路模式、到达到期检查点或执行毕业/放弃/恢复（workflow 路由表第 16 行） |
| `spike-run` | 项目处于有效 explore 模式（路由表第 17 行兜底）且任务未命中其余行 |
| `disposable-build` | 项目处于有效 disposable 模式（路由表第 18 行兜底）且任务未命中其余行 |

## Hooks

- SessionStart（`hooks/session-start.mjs`）：探路模式状态注入与到期检查点提醒（fail-open）；静默态分层诊断（corrupt/legacy 恒可见、absent 仅非治理域轻提醒，内部决策-044/内部规则-11）。

## 测试

```bash
node --test "scout/scripts/tests/*.test.mjs"
node scout/scripts/mode-state.mjs --selftest && node scout/hooks/session-start.mjs --selftest && node scout/scripts/check-consistency.mjs --selftest && node scout/scripts/mode-lifecycle.mjs --selftest
node workflow/scripts/check-residuals.mjs scout
```

## 许可

MIT（见 `LICENSE`）。
