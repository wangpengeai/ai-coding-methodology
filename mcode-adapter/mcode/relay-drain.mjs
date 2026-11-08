// 文件：mcode-adapter/mcode/relay-drain.mjs
// 描述：MCode 合成 UPS 投递腿的零依赖子钩子（内部任务-356）。宿主/适配层在缺
//       `UserPromptSubmit` 声明的包上由生成期补一个指向本脚本的处理器；shim 照常 spawn
//       本脚本，本脚本只消费 stdin 至 end 并零输出退出，随后由 shim 的既有 UPS 分支排干
//       `PLUGIN_DATA` 中继队列。**不读 stdin 即退出会在父进程写入时产生 EPIPE 理论面**，
//       故这里显式消费到 end（契约由 hook-shim.test.mjs 的「relay-drain 载体契约」组钉住）。
// 作者：wangp  创建：2026-11-08  版权：MIT（见 workflow/LICENSE）
// 依据：内部决策-034 决策 6（fail-open 与不假装通过）；同族先例 kimi-code-adapter/kimi/relay-drain.mjs（内部任务-302）
// 用法：不手工调用——命令由生成器写进包内 `hooks/hooks.mcode.json` 的 UserPromptSubmit 处理器
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', () => process.exit(0));
