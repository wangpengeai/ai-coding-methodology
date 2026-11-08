// 文件：frontmatter.mjs
// 描述：受限 frontmatter 解析（`key: value` 单行键值）；F-8 返回 body 起始行号，
//       供调用方把 body 相对行号换算成文件真实行号。
//       受限子集（内部任务-347/内部未决-142 定案）：单行 `key: value`；值侧成对引号（"…"/'…'）
//       剥离一层；重复键拒绝（返回 frontmatterError，meta null——不抛异常，调用方按
//       「不可解析」语义消费）；行尾注释/多行值不支持。specRefs 行值为裸 token
//       （parseSpecRefs 独立逐行解析、不经本解析器），不支持引号。
export function parseFrontmatter(text) {
  let source = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  if (!source.startsWith('---\n')) return { meta: null, body: source, bodyStartLine: 1 };
  const end = source.indexOf('\n---\n', 4);
  if (end === -1) return { meta: null, body: source, bodyStartLine: 1 };
  const block = source.slice(4, end);
  const body = source.slice(end + 5);
  const bodyStartLine = source.slice(0, end + 5).split('\n').length;
  const meta = {};
  const seen = new Set();
  for (const line of block.split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (seen.has(key)) {
      // 内部未决-142：重复键按不可解析返回（不抛异常——调用面有裸调用，抛错会中止整批校验）。
      return { meta: null, body, bodyStartLine, frontmatterError: `重复键：${key}` };
    }
    seen.add(key);
    let value = line.slice(idx + 1).trim();
    // 内部未决-142：值侧成对引号剥离一层（不对称引号保留原样——不支持转义语义）。
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }
  return { meta, body, bodyStartLine };
}
