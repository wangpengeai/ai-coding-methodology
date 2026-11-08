---
description: 运行 Agent 行为评测（replay 优先；live 显式 opt-in）
skills: agent-eval
---
本命令挂载 **skills/agent-eval/SKILL.md**，按该 skill 执行：

```bash
node <team-governance 安装根>/scripts/agent-eval.mjs --project-root <项目根> --suite <suite.json> --subject-hash <sha>
```

replay 离线可跑（CI 默认）；live 须显式 --live-adapter。用户参数：$ARGUMENTS
