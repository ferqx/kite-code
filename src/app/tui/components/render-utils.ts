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
 *  全量读取（无显式 offset/limit）返回空字符串，
 *  分片读取返回 " [lines 1-30 / 123]" 或 " [lines 31-60 / 123]" 等。
 *  Extract line range suffix from read_file tool args.
 *  Returns "" for full-file reads, e.g. " [lines 1-30 / 123]" otherwise. */
export function formatReadFileRange(args: Record<string, unknown>, totalLines?: number): string {
  const offset = typeof args.offset === "number" && args.offset > 1 ? args.offset : undefined;
  const limit = typeof args.limit === "number" ? args.limit : undefined;

  // 无显式 offset/limit → 全量读取，不显示范围
  // No explicit offset/limit → full-file read, suppress range
  if (offset === undefined && limit === undefined) return "";

  const start = offset ?? 1;
  const end = limit !== undefined ? start + limit - 1 : undefined;
  const suffix = totalLines != null ? ` / ${totalLines}` : "";
  if (end !== undefined) {
    return ` [lines ${start}-${end}${suffix}]`;
  }
  return ` [lines ${start}-${suffix}]`;
}
