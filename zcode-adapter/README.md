# zcode-adapter —— ZCode 宿主适配层（第一宿主装机工具面收敛）

> 内部决策-035（每宿主一写面）：仓内唯一源（六插件目录）之外，ZCode 机器态的唯一写路径是本适配层 CLI。
> 设计裁决与前提见 `内部规格 内部决策-035`；实施计划 `内部实施计划`；
> 同族适配层：`ai-coding-methodology/`（DSH，内部决策-032）、`mcode-adapter/`（MCode，内部决策-034）、`kimi-code-adapter/`（Kimi Code，内部决策-038）。

## 为什么是适配层

发布链此前散装在 `scripts/release-suite.mjs`（发布+验证）+ 手工装机指引 + 操作链收口，装机侧无 CLI（客户端无插件管理命令）。三个实发痛点（发布收口 26 探针手工对账 / 换机重放 / 发布声称与机器状态脱节——内部任务-INSTALL-051 六版本漂移实录）由本层一次性收敛为机械面。

## 四子命令

```
node zcode-adapter/cli.mjs verify [--marketplace <市场源>] [--json]        # 七面只读核对，漂移退 1
node zcode-adapter/cli.mjs publish --marketplace <市场源> [--skip-tests]   # 验证集 → 市场同步 → 清单刷新
node zcode-adapter/cli.mjs install [--marketplace <目录>] [--bootstrap] [--dry-run] [--version <校验>]
node zcode-adapter/cli.mjs bump [--repo-root <路径>] --version <X.Y.Z> --note "<摘要>" [--dry-run]   # 内部决策-024 版本折叠（仓库根缺省上溯推导，亦可位置参数，二者互斥）
node zcode-adapter/cli.mjs --selftest                                       # 24 项自检（内部接口-21 行为断言承载面；独立形态，不与子命令/其他参数组合）
```

公共参数仅 `--repo-root`（缺省上溯推导）与 `--help/-h`；`--zcode-home`（缺省 `~/.zcode`，`ZCODE_HOME` 注入缝）仅 verify/install，`--marketplace` 适用 verify/publish/install，`--json` **仅 verify**，`--skip-tests` 仅 publish，`--bootstrap`/`--dry-run`/`--version` 属 install，`--version`/`--note`/`--dry-run` 属 bump——**不适用的旗标一律显式退 2（禁静默忽略，R-za-1/内部未决-154，内部任务-275）**。位置参数仅 bump 接受（仓库根，与 `--repo-root` 互斥），其余子命令收到即退 2（内部任务-276）。退出码：0 绿 / 1 漂移·失败 / 2 用法错。

## verify 七面

F1 仓库源期望树（事实源；`__pycache__`/`.mimosa`/`.pyc` 过滤，与 assurance `probes.mjs treeHash` 同构编帧树哈希互证——内部未决-51）｜F2 市场源｜F3 派生镜像（清单逐字+树）｜F4 cache 登记版本目录｜F5 登记表双读（`registry.version == plugin.json@installPath.version`，installPath 尾分隔符比较侧归一）｜F6 `config.enabledPlugins`｜F7 市场注册面（known_marketplaces 的 directory 源指向与本次核对源一致——注册缺失/指向旧路径时六面可全绿的假绿场景补齐，内部未决-154/内部任务-275；**仅 verify CLI 口径计入退出码**，install 写后即验豁免、由 install 完成尾印核对承载）。版本流四处同版（repo 清单→市场清单→登记表→cache 目录名）。

## install 写序与写面纪律

F2 前置闸（市场源须新鲜，不新鲜提示先 publish）→ dry-run 早退（零写入）→ 客户端状态写前解析（坏 JSON/形态损坏零写拒绝）＋重放旁路闸（`.replay-aside` 存在即写前拒绝，零写）→ 备份三客户端文件（`.bak-<ts>`）→ cache 目标版本目录落位（**旧版本目录永不删**；同版本重放内容一致即零写跳过、不一致经 staging 拷贝＋双 rename 交换）→ 镜像对齐（幂等）→ 登记表原位保序更新（未触碰条目逐字保留）→ config 补齐 → **写后即验（七面；F7 注册面豁免计入，由 install 完成尾印核对承载——内部任务-275）**。完成尾印另核注册态：本次安装源未注册或注册指向他源时打「注意」提示（不阻断、不自动写 config）。失败回滚=三文件内存快照 + 新建 cache 目录删除；同版本重放目录交换成功后内容＝市场源，回滚无需恢复（拷贝/首发 rename 失败原目录原样保留；恢复 rename 失败时原内容保留于 `.replay-aside`，主文案报「回滚不完整」）。`--bootstrap` 新机冷启动：市场源缺省 `<zcode-home>/local-marketplace` 创建 + known_marketplaces 注册 + 从零启用。

## 已知限制

- 新版本需**新会话生效**（运行中会话 hook 路径指向启动时加载的版本目录）；旧版本 cache 目录已保留，勿手工删。
- 单操作者工具，不设并发防护（与 mcode-adapter 同姿态）。
- 六插件钩子以裸 `node` 声明解释器、由宿主进程按其 PATH 解析（内部未决-243）：verify 头部、install 收尾区（写后即验通过后）打印本 CLI 进程的解析结果（未解析＝显著告警，不阻断、不改写声明）；宿主进程 PATH 可能与终端不同，成功行不担保宿主进程侧可解析。
- 上次运行在重放交换窗口中断可能留下 `.replay-aside`（原内容）：须人工 rename/删除后才可再次重放——install 会写前拒绝并指认路径（不静默删除）。
- 首次实机 bootstrap 装机收口走 L2 操作链（install-criteria 判据仍由 spec-gate assurance 生产、gate 执行回读——内部决策-027 判据生产者/验证者分离，本层不自产自验）。
- 仓库领先已发布态时 `verify` 的 F2 会如实报红（这正是它存在的目的——发布声称随时可机检证伪）。

## 测试

测试项共 119 项（`tests/verify.test.mjs` × 22 + `tests/market.test.mjs` × 18 + `tests/publish.test.mjs` × 12 + `tests/bump.test.mjs` × 11 + `tests/install.test.mjs` × 36 + `tests/host-presence.test.mjs` × 6 + `tests/jsdoc-contract.test.mjs` × 4 + `tests/selftest.test.mjs` × 2 + `tests/cli-main.test.mjs` × 8；`tests/helpers.mjs` 夹具不计项；2026-10-12 内部任务-44 增 bump DSH 写面负例一组〔内部未决-57〕；2026-10-14 内部任务-82/内部未决-122 备份生命周期一拆二〔成功清＋超龄清〕；2026-10-16 内部任务-11 增宿主在位用例〔内部决策-048〕；2026-10-17 内部任务-60 增解释器版本闸（阶段5 已退役）；2026-10-19 内部任务-153 删 spawn-helpers 测试面，64→59；2026-10-25 内部任务-209 S2 增 selftest/cli-main 两个 in-process 覆盖文件〔内部未决-201 达阈，59→64〕；2026-11-01 内部任务-275 增 F7 注册面三态＋豁免、参数面错配通用校验、publish 写面回滚/自检/备份清理/清理失败告警、install 注册态尾印两用例、钩子解释器探测两用例＋评审修复批三用例与一断言补强〔同步失败退码／bootstrap 备份清理／超龄备份清理／悬挂注册断言〕〔内部未决-154/163/243＋round1 C1-C5/S1-S6，64→78〕；2026-11-01 内部任务-276 评审修复批增 38 项〔D1-D21：参数面收紧/读面守护族/重放原子化/写前解析/回滚逐项/备份告警＋覆盖缺口补强（F2 两臂、前置拒绝三例、verify 负分支四例、--json 输出面、note 内容闸等）＋缺省注入缝与不可读生成物两项，78→116〕；2026-11-06 内部任务-334 增 install 客户端状态不可读拒绝臂用例＋market 写后自检不可读折叠用例〔内部未决-251①/内部未决-249〕，116→118）。2026-11-08 内部任务-349 增 publish 非全绿尾印用例（判绿改行首锚定，118→119）。全部自含：夹具只落 `os.tmpdir()`（`assertInTmp` 把守），零真实 `~/.zcode` 触达；install/publish 测试含源仓 sha256+mtime 零改动不变量。`market.test.mjs` 的 3 项原子写重试用例锁 Windows 瞬时锁语义（内部任务-RELEASE-058）。

发布验证集入口：`node scripts/release-suite.mjs --validate-only`（验证集归仓库级，publish 调用而不拥有；2026-10-21 内部任务-188 起验证集含 `node zcode-adapter/cli.mjs --selftest` 独立步——内部接口-21 行为断言承载体入集，内部决策-054 G-06）。2026-11-08 内部任务-349 起验证集含**测量对象完整性**判定（启动披露＋运行后指纹比对；bump 后树天然脏只披露不阻断，publish 无需传旗标；手动跳过用 `--allow-dirty`）。

## 新宿主接入模板指针

第一宿主 ZCode 适配层：新宿主接入模板走 内部模块-22 `R-ha-6` **三阶段**（设计取证→规格批→实施批），接入前必做**先例对照**（过既有宿主已修缺陷与未决项清单）；本宿主的分册/矩阵行/缺口台账见 `内部规格 内部模块-22` 对应节。
