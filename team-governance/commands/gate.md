---
description: 生成治理报告（聚合 manifest/lease/approval/eval 四态核验，报告是治理结论的唯一出口）
skills: team-governance
---
本命令挂载 **skills/team-governance/SKILL.md**，按该 skill 执行：

```bash
node <team-governance 安装根>/scripts/governance-cli.mjs --project-root <项目根> gate
```

退出码 0/1/2；报告落 `.ai-governance/runtime/reports/governance-report.json`，spec-gate gate 的 governance 节只读消费四态。用户参数：$ARGUMENTS
