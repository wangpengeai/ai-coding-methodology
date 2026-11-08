---
templateId: atomic.open-items
documentType: open-item-register
validationMode: draft
allowedPlaceholders: {{REGISTER_TABLE}}
atomicSchemaAssetId: schema.open-item
---
# 结构化未决项登记（OPEN-n）

| 编号 | 状态 | 负责人 | 影响 | 阻塞性 | 收敛触发 | 证据 | 风险接受依据 | 风险接受触发 |
|---|---|---|---|---|---|---|---|---|
| {{REGISTER_TABLE}} | open/resolved/accepted-risk | 逐行填写 | 逐行填写 | 是/否 | 何时何事触发收敛 | 引用 | accepted-risk 时必填 | accepted-risk 时必填 |

> 未决内容只能使用本结构；禁止自由文本 TODO/TBD（RULE-内部未决-001）。
> 阻塞性未决项不得进入 baseline 定稿（RULE-内部未决-002）；accepted-risk 必须附风险接受依据与触发条件（RULE-内部未决-003）。
