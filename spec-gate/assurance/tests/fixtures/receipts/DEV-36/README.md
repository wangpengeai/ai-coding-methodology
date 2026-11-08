# 内部任务-36 冻结凭据夹具（只读）

- **来源**：本机 `内部治理状态`（`.sdd/*` 被 gitignore，git 历史不可取回——本目录为跨机可复现的唯一冻结面）。
- **复制日期**：2026-10-18（内部任务-91 阶段 2.2.1）。
- **来源仓 HEAD**：`0f07a1fec9f5945b7fa8a41beccc5bf6877ed046`。
- **复制范围**：仅 `*.json`（8 件）；复制后逐字节比对与源文件相等（sha256 清单如下）。
- **用途**：`tests/receipts.test.mjs` 冻结凭据夹具跨读——复制到 `<tmp>/内部治理状态` 后按 gate 凭据
  `chainProfile=dev` 调 `verifyReceiptChain`；断言固定 `(false, reason)` 与凭据文件完整性：
  计划 `内部计划` 不在 tmp 根
  ⇒ 内部未决-109「链绑定计划不可读/已删除」。（tmp 根由测试固定。）
- **纪律**：只读夹具，不得在测试中改写；缺失/损坏＝fail-loud 红（不静默空过）。

| 文件 | sha256 |
|---|---|
| code-review-内部任务-36-1.json | b16bfa0c0989693c051f8f6c11a400605906540ba0b966ec50169e7fdb1fc19c |
| code-review-内部任务-36-sstage1.json | 6e3b44a7025f876855e922afdbdf77f23a400662ceb4c682566db33e44cb354c |
| code-review-内部任务-36-sstage2.json | c53556aac0c6d5b2ec60c1c14a07dae93a6bde9e49259b4c9f53d87d15870252 |
| code-review-内部任务-36-sstage3.json | e64789cb24354321e49e153386a96ce07ceda140e110933cea0262d6f2ed30f9 |
| gate-内部任务-36-1.json | 45998432e9003744d3e08dbdc93c72a3a0a5d59896e2cb86f6d3cd334793620e |
| gate-内部任务-36-2.json | e70e9265eec7b506574ff6670281787a582b25db825957bf901b26027d6c35cb |
| gate-内部任务-36-3.json | a1ce67cc2358e73a5dd95eaeec5ca930bf311a1006ebcb3e22d58a3a94428fcb |
| verification-内部任务-36-1.json | b097b5e5870261537cb7fb8a2fc8847b3c5e25f809aba9310531527bc9a7df97 |
