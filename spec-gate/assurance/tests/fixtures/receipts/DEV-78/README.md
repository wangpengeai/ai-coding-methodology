# 内部任务-78 冻结凭据夹具（只读）

- **来源**：本机 `内部治理状态`（`.sdd/*` 被 gitignore，git 历史不可取回）。
- **复制日期**：2026-10-18（内部任务-91 阶段 2.2.1）。
- **来源仓 HEAD**：`0f07a1fec9f5945b7fa8a41beccc5bf6877ed046`。
- **复制范围**：仅 `*.json`（3 件）；复制后逐字节比对与源文件相等（sha256 清单如下）。
- **用途**：`tests/receipts.test.mjs` 冻结凭据夹具跨读——复制到 `<tmp>/内部治理状态` 后按 gate 凭据
  `chainProfile=operation` 调 `verifyReceiptChain`（该目录无 code-review，默认 dev 会先在选环阶段报
  「链不完整」而非 revision 分因）；；断言固定判定与凭据文件完整性：tmp 根 source/spec 与凭据不等
  ⇒ content-changed（`planSha256:null` 只是不触发计划桶重算）。
- **纪律**：只读夹具，不得在测试中改写；缺失/损坏＝fail-loud 红（不静默空过）。

| 文件 | sha256 |
|---|---|
| gate-内部任务-78-1.json | 078783303c71f1d6b26f28e4168751cef579c3613b5a2a7f8c2cce4e5a29d473 |
| operation-内部任务-78-1.json | 70689f52e25eab29cd1188e043ba93caa575e0f70bcb95ec83860e9ef10e3a1a |
| verification-内部任务-78-1.json | 578dccd79e9c7b139854c4806a4e5ad306b1b7e3c88febc5f77034733674b741 |
