---
description: 项目接入 SDD 方法论：探测规格体系状态，生成 .sdd 配置与套件骨架
argument-hint: [项目根目录，缺省当前目录]
---
运行 spec-gate 插件的项目接入工具。

步骤：

1. 定位本插件的 `core/validator/tools/sdd_init.mjs`（插件安装目录下与本命令同级的 `core/` 目录）。
2. 运行：`node <core>/validator/tools/sdd_init.mjs --project <项目根，缺省当前工作目录> --format json`。
3. 按报告中的 `specSystem` 处置：
   - `absent`/`partial`：提示用户转交 `spec-backfill` 技能建立体系（或运行 `/spec-gate:backfill`）；
   - `present`：提示登记验证命令（`内部治理状态` 的 validationCommands）与受检文档（`内部治理状态` 的 documents）。
4. 应用推荐 .gitignore 条目（接入自动应用，内部决策-043）：运行 `node <插件根>/scripts/apply-gitignore.mjs --project <项目根，缺省当前工作目录>`（`<插件根>`＝本命令所在插件安装目录，与步骤 1 同位置）——行级幂等合并、已有内容零改动；退出码 1 表示存在语义冲突需人工裁决，把报告中的冲突清单呈现给用户，不代改；可加 `--dry-run` 先预览。随后向用户提示可选 docs 段形态（见模板 `assets/gitignore-template` 头注——目录级 `docs/` 排除会吞白名单否定行）。
5. 幂等保证：已存在配置只校验不覆写（sdd_init，RULE-PROJ-001）；`.gitignore` 合并按整行判重幂等（apply-gitignore），重复运行零改动；如实报告问题清单。

用户参数：$ARGUMENTS
