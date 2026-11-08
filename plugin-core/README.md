# plugin-core：宿主中立核心（内部决策-036）

把六插件的声明面从 ZCode 插件形态解绑：中立清单是唯一手工编辑面，ZCode 形态（及期二的其余宿主形态）全部由物化器生成。

## 编辑面纪律

**唯一手工编辑面 = `<插件>/plugin.manifest.json`**（六插件根各一份：workflow / spec-gate / scout / team-governance / algo-loop / research-loop；research-loop 零钩子，物化仅产 plugin.json）。

展示名与描述同属此面：各插件的 `displayName`（如「AI Coding 方法论 · 工作流」）与 `description` 只在 manifest 编辑，各宿主的展示字段由此单源映射，勿在适配层手抄第二份；套件整体标题的唯一常量源是 `src/product-meta.mjs` 的 `SUITE_NAME`。改任一处后重跑 `materialize` 刷新生成物。

**勿手改生成物**：`.zcode-plugin/plugin.json`（恒产）与 `hooks/hooks.json`（仅 hooks 非空时产）是物化器的整体覆写产物，计划外旧生成物随物化删除——手工改动会在 `verify` 对拍处必现红。改动声明请编辑 manifest，随后按下方「命令用法」运行 `materialize` / `verify`。

## 命令用法

- `node plugin-core/cli.mjs materialize [--plugin <名>] [--repo-root <路径>]` —— 从中立清单物化 ZCode 形态生成物（缺省＝套件全部插件、仓库根为当前目录；先全量校验后全量写）。
- `node plugin-core/cli.mjs verify [--plugin <名>] [--repo-root <路径>]` —— 只读对拍：逐文件字节比较（`ok`/`changed`/`missing`/`extra` 四分类；`extra`＝计划外生成物），漂移逐文件列出并退 1。
- 退码：`0`=一致/成功；`1`=校验失败、漂移或写失败；`2`=用法错（含 `--repo-root` 不可访问）；预期内错误以单行 `[plugin-core] …` 输出（不抛栈）。

数据面：`capability-matrix.json`（能力键 × 宿主列）与 `degradation-rules.json`（十条降级先例，params 机读化 v2），另有**规则引擎**（内部决策-037 期二批 1）。

## 规则引擎（内部决策-037）

```js
import { createEngine, loadEngine } from './src/engine.mjs';
const engine = loadEngine(process.cwd());              // 装载期：规则库先过 validateRules，不合契约即拒载
const out = engine.applyRule('tool-vocab-map', 'dsh', { matcher: 'Bash|Edit' });
// → { applied: true, fidelity: 'lossy', result: 'pwsh|bash|Bash|edit|str_replace_editor|Edit' }
```

- **分派顺序（七段）**：入参形状守卫 → 规则存在性 → 宿主在矩阵 hosts 内 → `trigger.capability` 键集校验 → `params[host]` 参与判定与形态校验（未命中返回 `applied:false`；空对象/非对象 fail-closed）→ 端口必填校验 → 六族执行器；错误消息含 `ruleId=`/`host=`/缺失面（执行器异常同样包裹前缀）。
- **只读查询**：`hasRule(ruleId)` 供消费方装载期漂移闸（非字符串/空串返回 `false`，不抛错）。
- **六族执行器**（`src/strategies/`，一族一文件）：`emulate` / `map` / `normalize` / `relay` / `degrade` / `disable`；策略逻辑唯一实现点在引擎。
- **宿主端口**（按规则声明，副作用注入面）：`followup-expansion:{enqueue}`、`stop-pending-relay:{readState,writeState}`、`agent-default-off-fail-closed:{listRestrictableTools}`；其余规则为无端口纯函数（同族内 command-to-skill 亦无端口）。端口为**规则级无条件必需**——缺能力的宿主由调用方包兜底（fail-open 语义），引擎不因此改判。
- **fail-closed 两级**：装载期 `loadEngine` → `validateRules` 错误**列全拒载**；分派期 `applyRule` **首错即抛**。物化侧规则库接线随批 3；适配层会话期调用点维持各面既有 fail-open 语义（无「回落旧实现」逃生轨，内部接口-1 §4）。
- **契约收紧**（2026-10-27 内部任务-238，strict-backward）：manifest `version` 须为三段式 SemVer；占位符仅字面 `${PLUGIN_ROOT}`（大小写变体与 JSON 转义形态一律拒）；`${PLUGIN_ROOT}/…` 形式的 args 须落在插件根内；`validateRules` 增规则级跨字段不变式（to∈accepted、秒数区间、triggerEvent≠deliverOn）。
- 引擎代码零宿主字面量（宿主名只作数据键）；params 机制位为受读契约位，取值不受支持即 fail-closed。
- `validateRules(rulesDoc, matrixDoc)`（`src/validate.mjs`）是规则库 schema 权威，`PARAM_RULE_FIELDS` 为其单源导出。

## 三道把守

生成物一致性由三道互相独立的机器把守：① `node plugin-core/cli.mjs verify`（逐文件字节对拍，含计划外产物）；② `node scripts/check-repo-consistency.mjs` 的 plugin-core 块（manifest↔生成物静态对拍与中立性 lint）；③ `node scripts/release-suite.mjs --validate-only`（验证集编排，含前两道）。

## 测试

```bash
node --test "plugin-core/tests/*.test.mjs"
```

规格承载：`内部规格 内部模块-16`、`内部规格 内部接口-1`、内部决策-036。
