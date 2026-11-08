// 文件：diagnostics.mjs
// 描述：诊断数据结构（ruleId/severity/file/line/fixHint 固定键序）。
export function diagnostic(ruleId, severity, file, line, fixHint) {
  return { ruleId, severity, file, line, fixHint };
}

export function hasBlocking(diagnostics) {
  return (diagnostics ?? []).some((d) => d.severity === 'blocking');
}
