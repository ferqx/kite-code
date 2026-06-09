export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface ThemeColors {
  success: string;
  error: string;
  warning: string;
  muted: string;
}

export function toolColor(status: string, t: ThemeColors): string {
  switch (status) {
    case "done": return t.success;
    case "error": return t.error;
    case "running": return t.warning;
    default: return t.muted;
  }
}

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 从 read_file 工具的 args 中提取行号范围后缀。
 *  无显式 offset/limit 但有 totalLines → 展示完整范围 " [lines 1-36 / 36]"
 *  分片读取 → " [lines 1-30 / 123]" 或 " [lines 31-60 / 123]" 等。
 *  Extract line range suffix from read_file tool args.
 *  Full-file read with totalLines → " [lines 1-36 / 36]"
 *  Chunked reads → " [lines 1-30 / 123]" etc. */
export function formatReadFileRange(args: Record<string, unknown>, totalLines?: number): string {
  const offset = typeof args.offset === "number" && args.offset > 1 ? args.offset : undefined;
  const limit = typeof args.limit === "number" ? args.limit : undefined;

  // 全量读取（无显式 offset/limit）→ 如果已知 totalLines 则展示完整范围
  // Full-file read (no explicit offset/limit) → show full range if totalLines is available
  if (offset === undefined && limit === undefined) {
    if (totalLines != null) return ` [lines 1-${totalLines} / ${totalLines}]`;
    return "";
  }

  const start = offset ?? 1;
  const end = limit !== undefined ? start + limit - 1 : undefined;
  const suffix = totalLines != null ? ` / ${totalLines}` : "";
  if (end !== undefined) {
    return ` [lines ${start}-${end}${suffix}]`;
  }
  return ` [lines ${start}-${suffix}]`;
}
