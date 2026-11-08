---
description: 接入团队 AI 治理（幂等：已有配置不覆写）
skills: team-governance
---
本命令挂载 **skills/team-governance/SKILL.md**，按该 skill 执行：

```bash
node <team-governance 安装根>/scripts/governance-cli.mjs --project-root <项目根> init
```

幂等语义：探测 `.ai-governance/config.json` 已存在即不覆写（内部需求-13）。用户参数：$ARGUMENTS
