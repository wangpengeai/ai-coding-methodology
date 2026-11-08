# tests/golden 黄金向量

- 生成器 `tests/gen_golden.py` 已于 内部任务-100 阶段3b（C2）删除；向量由阶段0–1b 的 Python 生成器生成并冻结入库（`dir-tree-hash`/`event-hash` 分别在阶段1a/1b 追加；`BASE` 是可幂等再生的基线）。
- 向量本身不得手改（手补条目会被再生静默回滚）；禁止直接编辑 JSON。
- 再生须从 `BASE`（`ff02622d96e1f5f135980df04c19fffd8b048084`）临时重建的快照运行 `gen_golden.py`，或将快照生成结果与现存向量逐字节对照。
- C2 后剩余消费者：`common.test.mjs`（`canonical-json.json`/`sha256.json`/`now-iso.json`）、`probes.test.mjs`（`dir-tree-hash.json`）、`production.test.mjs`（`event-hash.json`/`secret-patterns.json`）；以 `rg -l "golden" spec-gate/assurance/tests/*.test.mjs` 实测为准。
- **内部任务-255（2026-10-30，批 3 N-1）**：`secret-patterns.json` 的 `redactionExpectedHits` 对照列**冻结**——该列跟随 tg `redaction.mjs` 文案历史；tg 侧文案已在 内部任务-255 改为「命中（已脱敏，长度 N）」不再回显片段，该列**无消费者**，以 `production_model.scanSecrets` 与 `production.test.mjs` 断言为准；**禁止为对齐 tg 文案手改向量**（改动须走 BASE 快照再生流程）。
- 关联：内部决策-051 D4；内部任务-100 阶段3b。
