---
description: 捕获项目验证命令的证据记录（退出码、输出摘要、脱敏），可追加到 内部治理状态
argument-hint: -- <验证命令及参数>
---
运行 spec-gate 插件的证据捕获工具。

步骤：

1. 定位本插件的 `core/validator/tools/capture_evidence.mjs`（插件安装目录下与本命令同级的 `core/` 目录）。
2. 将用户参数中 `--` 之后的部分作为被包装命令，运行：
   `node <core>/validator/tools/capture_evidence.mjs --project <当前工作目录> --criteria <选择条件，向用户确认> --append 内部治理状态 -- <命令>`。
3. 退出码透传被包装命令；证据按 schema.command-evidence 输出（密钥样式行自动脱敏，RULE-EVID-001）。
4. 将证据记录与任务关联（写入任务台账的对应条目或由用户登记）。

用户参数：$ARGUMENTS
