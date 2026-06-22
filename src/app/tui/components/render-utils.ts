export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** 工具名 → 用户界面友好名称映射 / Tool name → user-friendly display name mapping */
export const ACTION_NAMES: Record<string, string> = {
  edit_file: 'Update',
  write_file: 'Create',
};

export interface ThemeColors {
  success: string;
  error: string;
  warning: string;
  muted: string;
}

export function toolColor(status: string, t: ThemeColors): string {
  switch (status) {
    case 'done':
      return t.success;
    case 'error':
      return t.error;
    case 'running':
      return t.warning;
    default:
      return t.muted;
  }
}

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 从工具 args 提取人类可读的 preview 文本（文件名/命令名等）
 *  Extract human-readable preview text from tool args (filename, command, etc.) */
export function getToolPreview(name: string, args: Record<string, unknown>): string | undefined {
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return String(args.path ?? '') || undefined;
    case 'shell_execute': {
      const cmd = String(args.command ?? '');
      if (!cmd) return undefined;
      return cmd.length > 60 ? `${cmd.slice(0, 57)}...` : cmd;
    }
    case 'update_plan':
      return String(args.name ?? '') || undefined;
    case 'ask_user': {
      const q = String(args.question ?? '');
      if (!q) return undefined;
      return q.length > 40 ? `${q.slice(0, 37)}...` : q;
    }
    default:
      return undefined;
  }
}

/** 计算工具卡片的 detail 行文本（工具名后的一行描述）
 *  Compute detail line text for tool cards (one-line description after tool name) */
export function getToolDetail(
  name: string,
  args: Record<string, unknown>,
  totalLines?: number,
): string | undefined {
  switch (name) {
    case 'read_file': {
      const path = typeof args.path === 'string' ? args.path : '';
      const range = formatReadFileRange(args, totalLines);
      return `Read ${path}${range}`;
    }
    case 'write_file': {
      const path = typeof args.path === 'string' ? args.path : '';
      return `(${path})`;
    }
    case 'edit_file': {
      const path = typeof args.path === 'string' ? args.path : '';
      return `(${path})`;
    }
    case 'shell_execute': {
      const cmd = typeof args.command === 'string' ? args.command.slice(0, 60) : '';
      return `Ran: ${cmd}`;
    }
    case 'update_plan': {
      const name = typeof args.name === 'string' ? args.name : '';
      return `Plan: ${name}`;
    }
    case 'ask_user': {
      const q = typeof args.question === 'string' ? args.question.slice(0, 40) : '';
      return `Asked: ${q}${q.length > 40 ? '...' : ''}`;
    }
    default:
      return undefined;
  }
}

/** 从 read_file 工具的 args 中提取行号范围后缀。
 *  无显式 offset/limit 但有 totalLines → 展示完整范围 " [lines 1-36 / 36]"
 *  分片读取 → " [lines 1-30 / 123]" 或 " [lines 31-60 / 123]" 等。
 *  Extract line range suffix from read_file tool args.
 *  Full-file read with totalLines → " [lines 1-36 / 36]"
 *  Chunked reads → " [lines 1-30 / 123]" etc. */
export function formatReadFileRange(args: Record<string, unknown>, totalLines?: number): string {
  const offset = typeof args.offset === 'number' && args.offset > 1 ? args.offset : undefined;
  const limit = typeof args.limit === 'number' ? args.limit : undefined;

  // 全量读取（无显式 offset/limit）→ 如果已知 totalLines 则展示完整范围
  // Full-file read (no explicit offset/limit) → show full range if totalLines is available
  if (offset === undefined && limit === undefined) {
    if (totalLines != null) return ` [lines 1-${totalLines} / ${totalLines}]`;
    return '';
  }

  const start = offset ?? 1;
  const end = limit !== undefined ? start + limit - 1 : undefined;
  const suffix = totalLines != null ? ` / ${totalLines}` : '';
  if (end !== undefined) {
    return ` [lines ${start}-${end}${suffix}]`;
  }
  return ` [lines ${start}-${suffix}]`;
}
