export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const SPINNER_INTERVAL_MS = 80;

/** 工具名 → 用户界面友好名称映射 / Tool name → user-friendly display name mapping */
export const ACTION_NAMES: Record<string, string> = {
  read_file: 'Read',
  edit_file: 'Update',
  write_file: 'Create',
  search_content: 'Search',
  search_files: 'Find',
  shell_execute: 'Bash',
  read_mcp_resource: 'MCP',
  update_plan: 'Plan',
  ask_user: 'Ask',
  task: 'Task',
  Skill: 'Skill',
};

/** 取工具显示名，无映射则返回原名 / Get display name, fallback to original */
export function actionName(name: string): string {
  return ACTION_NAMES[name] ?? name;
}

export interface ThemeColors {
  primary: string;
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
    case 'cancelled':
    case 'timeout':
    case 'exhausted':
      return t.warning;
    case 'running':
      return t.primary;
    default:
      return t.muted;
  }
}

export function formatElapsed(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

/** 从工具 args 提取人类可读的 preview 文本（文件名/命令名等）
 *  Extract human-readable preview text from tool args (filename, command, etc.) */
export function getToolPreview(name: string, args: Record<string, unknown>): string | undefined {
  switch (name) {
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return String(args.path ?? '') || undefined;
    case 'search_content': {
      const p = typeof args.pattern === 'string' ? args.pattern : '';
      return p ? `"${p.slice(0, 55)}"` : undefined;
    }
    case 'search_files': {
      const p = typeof args.pattern === 'string' ? args.pattern : '';
      return p ? p.slice(0, 57) : undefined;
    }
    case 'shell_execute': {
      const cmd = String(args.command ?? '');
      if (!cmd) return undefined;
      const flat = cmd.replace(/\s+/g, ' ').trim();
      return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
    }
    case 'update_plan':
      return String(args.name ?? '') || undefined;
    case 'ask_user': {
      const q = typeof args.question === 'string' ? args.question : '';
      if (!q) return undefined;
      return q.length > 60 ? `${q.slice(0, 57)}...` : q;
    }
    case 'read_mcp_resource': {
      const uri = typeof args.uri === 'string' ? args.uri : '';
      const server = typeof args.server === 'string' ? args.server : '';
      if (!uri) return undefined;
      const label = server ? `${server}:${uri}` : uri;
      return label.length > 60 ? `${label.slice(0, 57)}...` : label;
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
    case 'search_content': {
      const pattern = typeof args.pattern === 'string' ? args.pattern : '';
      return `Search: "${pattern}"`;
    }
    case 'search_files': {
      const pattern = typeof args.pattern === 'string' ? args.pattern : '';
      return `Find: ${pattern}`;
    }
    case 'shell_execute': {
      const cmd = typeof args.command === 'string' ? args.command.slice(0, 60) : '';
      return `Ran: ${cmd}`;
    }
    case 'update_plan': {
      return typeof args.name === 'string' ? args.name : undefined;
    }
    case 'ask_user': {
      const q = typeof args.question === 'string' ? args.question : '';
      if (!q) return 'Asked';
      return q.length > 50 ? `${q.slice(0, 47)}...` : q;
    }
    case 'read_mcp_resource': {
      const uri = typeof args.uri === 'string' ? args.uri : '';
      const server = typeof args.server === 'string' ? args.server : '';
      return server ? `Read ${server}:${uri}` : `Read ${uri}`;
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
