export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export const SPINNER_INTERVAL_MS = 80;

export function spinnerIndexForElapsed(elapsedMs: number): number {
  return Math.floor(Math.max(0, elapsedMs) / SPINNER_INTERVAL_MS) % SPINNER.length;
}

/** 工具名 → 用户界面友好名称映射 / Tool name → user-friendly display name mapping */
export const ACTION_NAMES: Record<string, string> = {
  read_file: 'Read',
  edit_file: 'Update',
  write_file: 'Create',
  search_content: 'Search',
  search_files: 'Find',
  shell_execute: 'Bash',
  read_mcp_resource: 'MCP',
  write_plan: 'Plan',
  update_plan: 'Progress',
  ask_user: 'Ask',
  task: 'Task',
  Skill: 'Skill',
  web_fetch: 'Web Fetch',
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
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

/** 将单行文本压缩到展示宽度，保留路径首尾 / Truncate a single-line display value while keeping both path ends. */
function truncateSingleLine(value: string, maxLength = 100): string {
  const line = value.replace(/\s+/g, ' ').trim();
  if (line.length <= maxLength) return line;
  const tailLength = Math.min(32, Math.floor((maxLength - 1) / 2));
  return `${line.slice(0, maxLength - tailLength - 1)}…${line.slice(-tailLength)}`;
}

/** 压缩 Plan Artifact 路径，仅用于 TUI 展示，不改变实际文件路径。 */
function formatPlanArtifactPath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  const marker = '.kite-code/plans/';
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex < 0) return truncateSingleLine(normalized, 98);

  const segments = normalized
    .slice(markerIndex + marker.length)
    .split('/')
    .filter(Boolean);
  const fileName = segments.at(-1);
  if (!fileName) return '~/.kite-code/plans';

  const directories = segments.slice(0, -1);
  const shortenSegment = (segment: string) =>
    segment.length > 12 ? `${segment.slice(0, 8)}…` : segment;
  const displayDirectories =
    directories.length > 2
      ? [shortenSegment(directories[0]!), '…', shortenSegment(directories.at(-1)!)]
      : directories.map(shortenSegment);

  return `~/.kite-code/plans/${[...displayDirectories, fileName].join('/')}`;
}

/**
 * 将工具结果转换为用户可读摘要。
 *
 * write_plan 的 stdout 是给模型继续调用 submit 使用的机器可读 JSON，不能直接
 * 作为 TUI 文本展示；这里仅在展示层提取 Artifact 路径，保留模型侧协议不变。
 */
export function formatToolResultForDisplay(name: string, stdout: string, stderr: string): string {
  const raw = stdout || stderr;
  if (name === 'write_plan' && raw) {
    try {
      const result = JSON.parse(raw) as {
        status?: string;
        artifact?: { path?: string; relative_path?: string };
      };
      if (result.status === 'draft_saved') {
        const path = result.artifact?.path ?? result.artifact?.relative_path;
        return path ? `— ${formatPlanArtifactPath(path)}` : '— Plan draft saved';
      }
    } catch {
      // 兼容旧版本或非 JSON 工具结果，回退到原始输出。
    }
  }
  // 文件编辑结果本身就是面向用户的 diff。不能使用通用的 200 字符摘要
  // 上限，否则变更统计行之后的新增内容可能被截掉。
  // File edit results are already user-facing diffs. Do not apply the generic
  // 200-character summary cap, or additions after the stats line can disappear.
  if (name === 'edit_file' || name === 'write_file') return raw;
  return raw.slice(0, 200);
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
    case 'write_plan':
    case 'update_plan': {
      const title = typeof args.title === 'string' ? args.title : '';
      if (title) return title;
      // update_plan v2: show step progress summary
      const updates = args.updates as Array<{ step_id: string; status: string }> | undefined;
      if (Array.isArray(updates) && updates.length > 0) {
        return `${updates.length} step(s) updated`;
      }
      return undefined;
    }
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
    case 'web_fetch': {
      const u = typeof args.url === 'string' ? args.url : '';
      if (!u) return undefined;
      try {
        return new URL(u).hostname;
      } catch {
        return u.slice(0, 40);
      }
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
    case 'write_plan': {
      const title = typeof args.title === 'string' ? args.title : '';
      if (title) return title;
      const steps = args.steps as Array<{ title?: string; id?: string }> | undefined;
      if (Array.isArray(steps)) return `${steps.length} step(s)`;
      return undefined;
    }
    case 'update_plan': {
      const title = typeof args.title === 'string' ? args.title : '';
      if (title) return title;
      const updates = args.updates as Array<{ step_id: string; status: string }> | undefined;
      if (Array.isArray(updates)) return `${updates.length} step(s)`;
      const complete = typeof args.complete_plan === 'boolean' ? args.complete_plan : undefined;
      if (complete) return 'Plan completed';
      return undefined;
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
    case 'web_fetch': {
      const u = typeof args.url === 'string' ? args.url : '';
      if (!u) return undefined;
      try {
        return new URL(u).hostname;
      } catch {
        return u.slice(0, 60);
      }
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
