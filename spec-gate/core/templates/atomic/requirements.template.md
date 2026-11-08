---
templateId: atomic.requirements
documentType: requirement-baseline
validationMode: baseline
allowedPlaceholders: {{DOMAIN}}, {{REQUIREMENTS_TABLE}}, {{NONFUNCTIONAL_TABLE}}, {{WONT_TABLE}}, {{COULD_TABLE}}, {{ASSESSMENT_PROCESS}}, {{EVIDENCE_LEDGER_REF}}
atomicSchemaAssetId: schema.specification
---
# 需求基线（{{DOMAIN}}）

## 1. 功能需求（FR）

| 编号 | 需求 | 优先级 | 状态 | 证据来源 |
|---|---|---|---|---|
| {{REQUIREMENTS_TABLE}} | 编号格式 FR-域-n，全局唯一 | P0/P1/P2 | proposed/accepted/deferred/rejected | 台账条目编号 |

## 2. 非功能需求（NFR）

现状值与目标值必须分列，差距显式保留（RULE-BACKFILL-003）。

| 编号 | 类别 | 现状值 | 目标值 | 测量方法 |
|---|---|---|---|---|
| {{NONFUNCTIONAL_TABLE}} | 编号格式 NFR-域-n | 实测或保守下限 | 经确认的承诺 | 可复现方法 |

## 3. 明确不做（Won't）

| 项 | 理由 | 重新开启条件 |
|---|---|---|
| {{WONT_TABLE}} | 逐行填写 | 无则写「无」 |

## 4. 暂缓（Could）

| 项 | 触发条件 |
|---|---|
| {{COULD_TABLE}} | 逐行填写 |

## 5. 评估规程

{{ASSESSMENT_PROCESS}}（评估准入条件、评估方式、记录位置；未定义时写「沿用项目既有流程」）

## 6. 证据台账引用

{{EVIDENCE_LEDGER_REF}}（每条 FR/NFR 必须可回指证据台账条目，见 template.backfill.evidence-ledger）
