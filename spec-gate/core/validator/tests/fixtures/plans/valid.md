---
documentType: plan
specRefs: [内部需求-6, 内部决策-001]
---

# 计划：接入 plan 校验模式

## 步骤 1：实现校验函数

新增 core/plan_check.py，实现 check_plan。

验收：单元测试全绿。

## 步骤 2：CLI 接线

validate_specs.py 注册 --mode plan 与 --plan 参数。

验收：悬空引用计划经 CLI 校验退出码为 2。
