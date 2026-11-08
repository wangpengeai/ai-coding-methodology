# 内部任务-86 冻结凭据夹具（只读）

- **来源**：本机 `内部治理状态`（`.sdd/*` 被 gitignore，git 历史不可取回）。
- **复制日期**：2026-10-18（内部任务-91 阶段 2.2.1）。
- **来源仓 HEAD**：`0f07a1fec9f5945b7fa8a41beccc5bf6877ed046`。
- **复制范围**：仅 `*.json`（16 件）；复制后逐字节比对与源文件相等（sha256 清单如下）。
- **用途**：`tests/receipts.test.mjs` 冻结凭据夹具跨读——复制到 `<tmp>/内部治理状态` 后按 gate 凭据
  `chainProfile=dev` 调 `verifyReceiptChain`；断言固定 `(false, reason)` 与凭据文件完整性：
  计划 `内部计划` 不在 tmp 根
  ⇒ 内部未决-109「链绑定计划不可读/已删除」。（tmp 根由测试固定。）
- **纪律**：只读夹具，不得在测试中改写；缺失/损坏＝fail-loud 红（不静默空过）。

| 文件 | sha256 |
|---|---|
| code-review-内部任务-86-1.json | 969b7714a634afd1cacfb82856295bf12866ffa5b1f6d335020bedec62fd6361 |
| code-review-内部任务-86-2.json | 522f0e8f6b0bb997f08fb97eee3af5f66d5c200d61016899e8dcd69c32a376a8 |
| code-review-内部任务-86-3.json | c06306fc7c2fe735cd60708eeb390728024df2bb88a3f698fb161f3e9d774793 |
| code-review-内部任务-86-s1.json | e61745e360aa9e6c555b4b9691a0b41de9bdaedcce80758c7464c6754ff2ef89 |
| code-review-内部任务-86-s2.json | e2da2d272db0af5ace147e9948af9ac8bf7b76713a57bac361106c13e7089365 |
| gate-内部任务-86-1.json | 9a7c2399f0a7b936e0dabf5ebbe52a54d15c3f6969da3469d685ad6c03ff70f0 |
| gate-内部任务-86-2.json | f817c2e9def90c0ff16588d8f637eb7927034844559d4399844b065d66f139b4 |
| gate-内部任务-86-3.json | 6fc35e9ea3b6c56bcc310542e81e0f37342f0999674b59ad69bfbb70c19ad31b |
| verification-内部任务-86-1.json | 261187a658bd9f12b6daf3768888c0ffce6b3397a6672714afb985cfa02db1dd |
| verification-内部任务-86-2.json | 95a0dd9a0af74dfa2c1c5712ae82171bb06df70b5f54d9d1d61d1e95f8d15822 |
| verification-内部任务-86-3.json | 51691e7b8be1713c71c2d4c44f464dbf14d177c3f1ab7d00697b7bcb2c5994a7 |
| verification-内部任务-86-4.json | 74a62ab4a8bd37ae2496e4edd6dfcd4aa35de4963ec35b990e7fb5200381c5b3 |
| verification-内部任务-86-5.json | c616b495957787c58d5b99ec849c5d0d1d569266721a4bba42a690227a324d27 |
| verification-内部任务-86-6.json | f0bb57c33cf195547196f90faf78659cfd213bcd3578630eaa1b6c2f88f36d94 |
| verification-内部任务-86-7.json | c69f3e4f3720e7c26589a34ef923e63a4327874eda66ff5c8d73fa422d655556 |
| verification-内部任务-86-8.json | e7f5a159a8059e0c9ec980db1e59a1110ee67927ae4312ec4c427a72a2aa94ba |
