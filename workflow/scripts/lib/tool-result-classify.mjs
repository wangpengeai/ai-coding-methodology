// 文件：tool-result-classify.mjs
// 描述：内部模块-15 v2 失败判据与分类指纹链的**生产实现单源**（内部规则-1/内部验收-30 / 内部决策-063 修正案 3
//       决策 20，2026-10-24 内部任务-195）——从 `hooks/post-tool.mjs` 原样下移：
//       ① `classifyResult`（结构化事实唯一判据、固定判序、显式退 0 不记、字符串/渲染文本不记）；
//       ② 其依赖的分类指纹链 `commandFingerprint`/`actionFingerprint` 与宿主错误码形态 `CODE_RE`。
//       为什么下移：判据被两个消费方共用（捕获钩 post-tool 与就绪面 canary session-start），
//       跨钩导入会让接口方向倒置（内部决策-063 决策 20 备选与否决）；lib 只依赖 incident-store 的
//       `digestOf`，**不得反向 import 任何钩子入口**（单向依赖，编译期即可检查）。
//       语义零改动：本文件是纯函数搬移，注释保留原判据理由（脱敏、判序、digest 细分）。
// 作者：wangp  创建：2026-10-24（自 post-tool.mjs 2026-09-13 版下移）  版权：MIT（见 workflow/LICENSE）
// 用法：`hooks/post-tool.mjs` 同名再导出（既有调用零改动）＋ `hooks/session-start.mjs` 直接导入。
import { digestOf } from './incident-store.mjs';

/**
 * 命令指纹（内部规则-2 脱敏：只哈希、不存原文）：从 `tool_input` 取命令/路径类字段之一
 * （`command` → `file_path` → `path` → `filePath`），空白归一、截 300 字符后哈希；
 * 取不到时返回 `nocmd`（常量指纹，保证 digest 稳定可去重）。
 * @param {unknown} toolInput 工具入参（宿主负载 `tool_input`）
 * @returns {string} 16 位十六进制指纹或 'nocmd'
 */
export function commandFingerprint(toolInput) {
  const src = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const raw =
    typeof src.command === 'string' ? src.command
      : typeof src.file_path === 'string' ? src.file_path
        : typeof src.path === 'string' ? src.path
          : typeof src.filePath === 'string' ? src.filePath : '';
  const normalized = raw.replace(/\s+/g, ' ').trim().slice(0, 300);
  return normalized ? digestOf(['cmd', normalized]) : 'nocmd';
}

/**
 * 工具动作身份（进失败记录 digest）：在命令/路径指纹之上补**动作定义字段**的哈希。
 * 为什么需要它（内部任务-DIGESTDISC-1 实测）：`edit`/`write` 的入参没有 `command`，指纹只落到
 * `file_path` ⇒ 同一文件上**任意不同尝试**（不同 `old_string`/`new_string`/`content`）会同 digest，
 * 账本读侧无法据 digest 归因（实测三例异质失败同 digest `a09c00f3…`）。补上动作定义后，与 bash
 * 「不同命令 ⇒ 不同 digest」的既有语义同构。
 * **存在的动作定义字段全部并入**（不做 edit/write 判序：判序会依赖"两参数互斥"这一未证实的宿主前提，
 * 且两字段同时出现时会吞掉 `content` ⇒ 原缺陷原样复现）；空串与非字符串等价于"无该字段"；**空白串仍计为存在**、
 * 不做空白归一/截断（此点与 `commandFingerprint` 的归一口径**不同**）；无动作定义字段的工具（bash/read 等）
 * **原样返回**基础指纹 ⇒ 零迁移面。
 * @param {string} toolName 工具名
 * @param {unknown} toolInput 工具入参
 * @returns {string} 16 位十六进制指纹
 */
export function actionFingerprint(toolName, toolInput) {
  const src = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const base = commandFingerprint(src);
  const str = (v) => (typeof v === 'string' ? v : '');
  const oldStr = str(src.old_string);
  const newStr = str(src.new_string);
  const content = str(src.content);
  const extra = [];
  if (oldStr !== '' || newStr !== '') extra.push('edit', digestOf(['old', oldStr]), digestOf(['new', newStr]));
  if (content !== '') extra.push('write', digestOf(['content', content]));
  if (extra.length === 0) return base;
  return digestOf(['action', toolName, base, ...extra]);
}

/** 宿主错误码形态判据（内部任务-20 B/F3）：首字符字母、允许 `._:-`、总长 ≤41（两宿主形态兼容）。 */
const CODE_RE = /^[A-Za-z][A-Za-z0-9_.:-]{1,40}$/;

/**
 * 失败判定（防御解析，导出供测试）——**结构化事实唯一判据**（2026-09-29 内部任务-OPEN46-1）：
 * 对象面判序固定：`error` 字段 → `is_error` → 退出码非零 → 退出码为零即成功（不记）→
 * `stderr` → 不记录；字符串与其它形态一律不记录——文本不单独构成失败判据：旧实现按
 * "输出行首错误样式 token"判定，在第二宿主上双向失真（退 0 且正文含错误样式行/他次回显
 * 被记假阳性；带文本退出标记的真失败零记录），且把宿主文本标记引入核心件会破多宿主原则
 * （宿主 seam 契约归适配层）。
 * @param {string} toolName 工具名（进 digest）
 * @param {unknown} result 工具结果（对象=结构化面；其余形态不记录）
 * @param {unknown} [toolInput] 工具入参（进命令指纹）
 * @returns {{errorClass: string, exitCode: number|null, digest: string, errorCode?: string}|null} 失败分类、退出码、归一 digest 与**可选**宿主错误码；null=不记录
 */
export function classifyResult(toolName, result, toolInput = {}) {
  if (result === null || result === undefined) return null;
  if (typeof result !== 'object') return null; // 文本/其它形态不单独构成失败判据（内部未决-46①）
  const fp = actionFingerprint(toolName, toolInput);
  // 返回面（视角二 #2）：除 digest 外透出 errorClass 与退出码——digest 是哈希、不可解读，
  // 记录里带上**类别名与数字退出码**（均非原文，不破 B-M15-1），operator 才看得懂账本。
  // 内部任务-20 B/F3（内部决策-033 修正案 1）：再透出**宿主结构化错误码** `errorCode`，但受三重约束——
  // ① **provenance**：只认结构化字段 `result.errorCode`（适配层自 `result.error.info.code` 透传），
  //    绝不从 `stdout`/`error`/`stderr` 文案里抠；② **形态**：`CODE_RE`（大写蛇形与小写类别串
  //    均接受——DSH 守卫码 `FS_*` 与 Kimi 类别串 `internal` 不同构，实测见 b-code-domain.md）；
  // ③ **语义作用域**：仅 `error-field`/`error-flag` 两个"真失败"类携带——`exit-nonzero` 属
  //    **证据层**（内部决策-033 决策 1/3），带码会把证据层噪声重新染成"可归因失败"，故一律不落。
  const hit = (errorClass, variant, exitCode = null) => {
    const out = {
      errorClass,
      exitCode,
      digest: digestOf(['tool-failure', toolName, errorClass, variant, fp]),
    };
    const code = result.errorCode;
    if ((errorClass === 'error-field' || errorClass === 'error-flag') && typeof code === 'string' && CODE_RE.test(code)) {
      out.errorCode = code;
    }
    return out;
  };
  const err = typeof result.error === 'string' ? result.error : '';
  if (err.trim()) return hit('error-field', 'field');
  if (result.is_error === true || result.isError === true) return hit('error-flag', 'flag');
  // 退出码只认数字与**非空数字字符串**（阶段复审 C2）：`''`/`false`/对象经 Number() 会强转 0，
  // 命中"退出码 0 即成功"提前返回、吞掉其后的 stderr 分支（`{exit_code:'', stderr:'boom'}` 漏报）。
  const rawCode = result.exit_code ?? result.code;
  const code = typeof rawCode === 'number' ? rawCode : typeof rawCode === 'string' && rawCode.trim() !== '' ? Number(rawCode) : NaN;
  if (Number.isFinite(code) && code !== 0) return hit('exit-nonzero', String(code), code);
  if (Number.isFinite(code) && code === 0) return null; // 显式成功：正文 token 不构成失败（评审 R-2 姿态保留）
  const se = typeof result.stderr === 'string' ? result.stderr : '';
  if (se.trim()) return hit('stderr', 'stderr');
  return null; // 无结构化事实：不可知，不记（fail-open 半边：宁漏不误报）
}
