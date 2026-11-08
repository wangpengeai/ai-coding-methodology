# 内部任务-107 预期跳过清单（expected skips）

> 机器判据唯一源：`内部预期跳过清单`；本文件是同一内容的人读视图，不一致即红（W0.3 单测比对）。

本清单是 W0.4/W0.5 取证日志的判据：**日志中出现清单外的跳过项即红**；清单内项目按平台逐条核对名字与理由。

## 判定规则

- win32 安全类用例（win32 原生 ACL、auditpol、symlink 逃逸/目标扫描探针）**不得**出现在 win32 跳过清单中；win32 取证必须在提权/Developer Mode 下执行它们。下表中 `checkBoundaries` 的 POSIX 语义变体是**跨平台语义对照**（源条件为 `process.platform === 'win32'`），在 win32 无对应物，属预期跳过，不属「win32 安全类探针」。
- POSIX 专属语义（symlink、文件名首尾空格/换行/冒号、mode-only）在 win32 无稳定表示，属预期跳过。
- `probes.test.mjs` 的 auditpol 实机往返是 win32-only；darwin/linux 跳过属预期。
- 条件性跳过（运行期能力缺失）只允许本节条件表中的条目；条件不成立时出现跳过即红。

## JS（`node --test "spec-gate/assurance/tests/*.test.mjs"`）

| 文件 | 测试名 | 跳过平台 | 理由 |
|---|---|---|---|
| `probes.test.mjs` | `runProbes：auditpol 实机往返（win32-only；darwin skip——台账 win32 基线节登记）` | darwin / linux | auditpol 为 Windows 命令；win32 实机覆盖 |
| `archive.test.mjs` | `tar 内核：POSIX symlink linkname 中的反斜杠是合法字面量，不归一` | win32 | POSIX 反斜杠字面量在 win32 无对应语义 |
| `revision.test.mjs` | `test_symlink_commit_is_equivalent：symlink 提交⇒等价（POSIX）` | win32 | win32 无 POSIX symlink 语义 |
| `revision.test.mjs` | `test_mode_only_commit_is_equivalent_under_blob_rule：仅 mode 变更⇒等价（blob 口径）` | win32 | win32 `core.fileMode` 语义不可靠 |
| `revision.test.mjs` | `test_whitespace_path_is_equivalent：首尾空格/内嵌换行路径⇒等价（钉 -z 与无 strip）` | win32 | win32 文件名首空格/换行语义不可靠 |
| `revision.test.mjs` | `test_leading_colon_path_is_equivalent：前导冒号路径⇒等价（钉 --literal-pathspecs）` | win32 | win32 文件名不允许冒号 |
| `revision.test.mjs` | `无效 UTF-8 路径：computeRevisionSet 抛 RevisionDecodeError、headEquivalent fail-closed` | win32 | win32 路径编码面不可构造 |
| `receipts.test.mjs` | `verifyReceiptChain 非 UTF-8 契约：严格解码失败转 (false, 具名诊断) 不异常穿透` | win32 | win32 路径编码面不可构造 |
| `zcode-adapter/tests/spawn-helpers.test.mjs` | `R1 行为级拒绝分支：低版本候选（3.8.10）被闸跳过 → 无其余候选 → 耗尽返回 null` | win32 | win32 无 POSIX shebang 桩执行语义；单元/源码断言仍覆盖 |
| `zcode-adapter/tests/spawn-helpers.test.mjs` | `R2 行为级接受分支：达标候选（3.11.4）被接受` | win32 | 同上 |

### 条件性跳过（非平台清单）

| 文件 | 测试名 | 条件 | 处置 |
|---|---|---|---|
| `cli.test.mjs` | `test_plan_symlink_resolves_to_target` | win32 且 symlink 创建失败（无 Developer Mode/权限） | 取证要求提权运行，正常应为**执行**；日志出现该跳过即判 W0.4 不合格 |

## 核对口径

- darwin 主 clone：JS 套件应只有 auditpol 1 项跳过。
- linux（非 root）：JS 套件 auditpol + PR6 共 2 项跳过。
- win32（提权）：JS 套件仅 POSIX 语义项跳过；安全类零跳过。
- Python 套件已于 内部决策-051 阶段4 退役（`spec-gate/**` 零 `.py`），本清单不再维护 Python 行。

