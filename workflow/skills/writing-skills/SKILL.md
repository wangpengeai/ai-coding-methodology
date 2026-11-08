---
name: writing-skills
description: 用测试先行的方法编写或修改技能本身 —— 触发条件：新建或修改任何 skill 文件时。
license: MIT
---

# writing-skills：技能本身的测试先行写作法

## 适用场景

元技能（表外 skill，非场景入口，路由表不路由至此）：当任务对象是 skill 文件本身——新建 skill、修改既有 skill 正文、调整触发 description——本方法适用。技能是"给模型读的代码"，同样适用"没看过失败就不算数"的纪律。

## 流程

### 第 1 步：压力场景先行

动手写技能前，先列出该技能必须正确处理的 5-8 个真实压力场景，每个场景一句话描述输入与期望行为。必须包含：

- 至少 2 个"不该触发"的近邻场景（防止 description 过宽导致误触发）
- 至少 1 个"必须触发"的典型场景（防止 description 过窄）
- 至少 1 个边界场景（任务很小/很大、用户表达模糊、与其他 skill 职责交界处）
- **决策确认检查点**：清单产出后、动笔前——凡关键设计决策存在真实选项空间（章节结构取舍、frontmatter 契约形态、与其他 skill 的职责切分、是否新增路由入口等），先列出候选选项与取舍，经用户确认后再定稿动笔；分歧较大或属方法论新方向时转 brainstorming 走批准门。用户消息内的确认即留痕，结论与压力场景清单同载。「选最常见的方案」不构成免确认理由。

### 第 2 步：建立基线

改动前先跑可用的机器检查并记录结果（基线），按 skill 形态取对应口径：

- **插件内 skill**（本仓库 workflow/scout 等的 skills 目录下）：
  - `node workflow/scripts/check-residuals.mjs <插件目录>`（残留红线）
  - `node workflow/scripts/check-routing.mjs`（frontmatter/路由一致性，增量模式按需）
- **独立 skill**（宿主用户级技能目录等插件仓外形态——目录形态因宿主而异，不硬编码路径）：
  - `node workflow/scripts/check-residuals.mjs <skill目录>`（红线扫描接受任意目录参数，独立 skill 直扫其根目录）
  - frontmatter 三字段人工对照第 3 步统一风格（name/description/license；description ≥30 字符且含「触发条件：」锚点）
  - 不适用项：check-routing 的入口清单（单源 `scripts/lib/routing-skills.mjs`，当前 22 项，数字随清单变动勿在正文另抄）与路由表双向对照（读 `skillsRoot/workflow/SKILL.md`），对独立 skill 根不可运行——不得以「跑不了」为零违例凭据，也不以跳过它为违例；本口径即其判定面。
- 涉及跨插件行为的，跑 spec-gate 校验器确认 0 阻断

### 第 3 步：写/改技能

按统一风格写作：中文正文、frontmatter 三字段、description「一句话功能 —— 触发条件：…」≥30 字符、章节骨架（适用场景→流程→接口→边界）、术语对齐 glossary、第三方思想自写表达。受众自查（口径见 doc-discipline 纪律七）：description 是公开选择说明——先功能/适用条件/限制/动作，禁以 ADR/IF 等内部编号代替解释，删编号不丢触发语义；成稿跑 `node scripts/check-repo-consistency.mjs` 确认 public-metadata 组零违例。

### 第 4 步：复测对照

重跑第 2 步全部检查（分形态口径与第 2 步一致），对照基线：不得引入新违例；若场景判定行为变化（触发条件调整），逐条对照第 1 步压力场景自查"该触发的触发、不该触发的安静"。新增场景入口 skill 时必须同步改 workflow 元技能路由表（互为一致性义务）。

### 第 5 步：经验回流

写作中发现的坑（哪类 description 措辞导致误判、哪类场景容易被漏）记一条 learnings（一行，证据链接指向本次提交）。

## 与其他 skill 的接口

- 元技能 workflow：新增/删除场景入口 skill 时同步改路由表（双向一致性）
- brainstorming：第 1 步决策确认检查点的分歧升级出口（设计决策批准门，内部接口-6 归口）
- learnings：第 5 步回流
- spec-gate：技能若涉及跨插件协议（IF 引用变化），先改 specs/ 对应契约再改技能（先回写后实现）

## 边界与禁止项

- 不评审技能内容本身的质量（内容质量归各 skill 自己的验收清单）
- 压力场景清单不是测试文件——它是写作前的思考工具，落在技能写作记录里即可，不要求持久化为独立文件
- 禁止跳过第 2 步基线直接改正文（"只是小改"不构成豁免理由）
