---
templateId: backfill.evidence_ledger
documentType: evidence-ledger
validationMode: draft
allowedPlaceholders: {{LEDGER_TABLE}}, {{SOURCE_INVENTORY}}, {{RECON_DATE}}, {{PLACEHOLDER_FORM}}
assemblyOf: schema.specification, schema.open-item
---
# 勘察与证据台账

> 装配模板：只组合与引用原子 schema（assemblyOf），不重新定义条目语法；占位符仅允许 {{PLACEHOLDER_FORM}} 形式。

## 1. 信息源清单

{{SOURCE_INVENTORY}}（入口骨架/目录模块地图/依赖清单/测试目录/提交历史/配置与错误码；每项标注获取方式与日期 {{RECON_DATE}}）

## 2. 证据台账

| 编号 | 模块 | 行为/事实描述 | 代码位置 | 证据来源 | 事实分类 | 置信度 |
|---|---|---|---|---|---|---|
| {{LEDGER_TABLE}} | 逐行填写 | 逐行填写 | 文件:行 | 测试/注释/提交/配置/文档/运行观察 | 见下表 | confirmed/high/medium/low |

## 3. 事实分类（升格前置条件）

| 分类 | 可进入规定性基线 | 处理方式 |
|---|---|---|
| 已确认意图 | 是 | 直接登记，附确认来源 |
| 兼容约束 | 是 | 登记为规格或 ADR，附证据与适用范围 |
| 偶然实现 | 否 | 只进实现注记 |
| 已知缺陷 | 否 | 进缺陷/风险清单 |
| 技术债 | 否 | 进债务或改进清单 |
| 未知意图 | 否 | 进假设或结构化未决项（OPEN-n） |
| 安全/合规风险 | 否 | 进风险清单，不得因现状如此而批准 |

## 4. 登记纪律

- 无证据来源的断言不得进入基线（RULE-BACKFILL-001）。
- 只有「已确认意图」与「兼容约束」可直接升格（RULE-BACKFILL-002）。
