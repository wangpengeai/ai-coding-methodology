---
normative: false
introducesRules: false
host: zcode
---

# ZCode 适配示例

> **非规范性，不产生新规则。** 本文件只演示如何把核心协议中的抽象能力映射到 ZCode 宿主；
> 核心规则、schema 与校验器不引用本文件，删除本文件不影响任何验收。

## 1. 项目级偏好持久化（opt-out / DDD 等级）

核心协议只要求「发现宿主实际提供的项目级持久偏好机制，写入后读回验证」。在 ZCode 中可映射为：

1. 发现机制：当前会话上下文会给出本项目 memory 目录的绝对路径；**只使用该实际给出的路径**，不猜测哈希或目录名；
2. 写入：按 ZCode memory 惯例创建独立条目文件（含 frontmatter `name`/`description`/`metadata.type`），并在索引文件追加一行链接；
3. 读回验证：重新读取条目与索引，比较字段完整性；失败则如实降级为当前任务豁免；
4. 恢复：按 scope 精确删除条目文件与索引行，再读回验证；仍被更广 scope 覆盖时报告「仍被抑制」。

字段内容遵循 `schema.opt-out`；宿主文件格式是适配细节，不是核心契约。

## 2. 技能调用与路由

- 宿主支持技能调用时：`sdd-ddd-tdd` 在体系缺口时调用 `spec-backfill`，单次规格变更调用 `spec-writing`；
- 宿主不支持调用时：执行代理直接按核心公开资产（manifest 的 `template.*`/`schema.*`）与三个技能正文执行同等流程。

## 3. 校验器与验收入口

```text
node <core>/validator/validate_specs.mjs --config <suite>.json --mode baseline --format json
node <core>/validator/run_acceptance.mjs --suite-root <skills-root> --format json
```

Node 为四宿主必装运行时；退出码语义不变（0/1/2）。
