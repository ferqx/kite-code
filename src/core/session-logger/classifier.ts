// src/core/session-logger/classifier.ts
// 工具失败原因分类——从 tool_done summary 文本解析失败原因

/** 结构化工具失败原因 */
export const ToolFailureReason = {
  SHELL_NONZERO_EXIT: 'shell_nonzero_exit',
  SHELL_COMMAND_NOT_FOUND: 'shell_command_not_found',
  SHELL_PERMISSION_DENIED: 'shell_permission_denied',
  SHELL_TIMEOUT: 'shell_timeout',
  SHELL_REJECTED_POLICY: 'shell_rejected_policy',
  EDIT_NO_MATCH: 'edit_no_match',
  EDIT_MULTIPLE_MATCHES: 'edit_multiple_matches',
  EDIT_EMPTY_OLD_STRING: 'edit_empty_old_string',
  READ_FILE_NOT_FOUND: 'read_file_not_found',
  READ_NOT_TEXT: 'read_not_text',
  READ_PERMISSION_DENIED: 'read_permission_denied',
  WRITE_PERMISSION_DENIED: 'write_permission_denied',
  WRITE_PATH_IS_DIR: 'write_path_is_dir',
  FILE_SYSTEM_ERROR: 'file_system_error',
  MCP_SERVER_UNAVAILABLE: 'mcp_server_unavailable',
  MCP_TOOL_FAILED: 'mcp_tool_failed',
  SUBAGENT_FAILED: 'subagent_failed',
  SUBAGENT_TIMEOUT: 'subagent_timeout',
  SUBAGENT_ABORTED: 'subagent_aborted',
  TOOL_NOT_AVAILABLE: 'tool_not_available',
  UNKNOWN: 'unknown',
} as const;

export type ToolFailureReason = (typeof ToolFailureReason)[keyof typeof ToolFailureReason];

/** 从 tool_done 事件 summary 分类 failure_reason */
export function classifyToolFailure(toolName: string, summary: string): ToolFailureReason {
  const s = summary.toLowerCase();

  // 通用检测：工具不在子 agent 允许集合中 / Generic: tool not available in sub-agent
  if (/not available to this sub-agent/i.test(s)) return ToolFailureReason.TOOL_NOT_AVAILABLE;

  if (toolName === 'shell_execute') {
    if (/command not found/i.test(s)) return ToolFailureReason.SHELL_COMMAND_NOT_FOUND;
    if (/permission denied/i.test(s)) return ToolFailureReason.SHELL_PERMISSION_DENIED;
    if (/timed? ?out/i.test(s)) return ToolFailureReason.SHELL_TIMEOUT;
    if (/rejected by tool policy/i.test(s)) return ToolFailureReason.SHELL_REJECTED_POLICY;
    return ToolFailureReason.SHELL_NONZERO_EXIT;
  }

  if (toolName === 'edit_file') {
    if (/no match|old_string not found|not found in/i.test(s))
      return ToolFailureReason.EDIT_NO_MATCH;
    if (/multiple matches|matches multiple/i.test(s))
      return ToolFailureReason.EDIT_MULTIPLE_MATCHES;
    if (/empty|old_string.*required|requires old_string/i.test(s))
      return ToolFailureReason.EDIT_EMPTY_OLD_STRING;
    if (/file not found|ENOENT|no such file/i.test(s)) return ToolFailureReason.READ_FILE_NOT_FOUND;
    if (/binary|not a text/i.test(s)) return ToolFailureReason.READ_NOT_TEXT;
    if (/permission denied/i.test(s)) return ToolFailureReason.WRITE_PERMISSION_DENIED;
    return ToolFailureReason.UNKNOWN;
  }

  if (toolName === 'read_file') {
    if (/file not found|ENOENT/i.test(s)) return ToolFailureReason.READ_FILE_NOT_FOUND;
    if (/binary|not a text/i.test(s)) return ToolFailureReason.READ_NOT_TEXT;
    if (/permission denied/i.test(s)) return ToolFailureReason.READ_PERMISSION_DENIED;
    return ToolFailureReason.UNKNOWN;
  }

  if (toolName === 'write_file') {
    if (/permission denied/i.test(s)) return ToolFailureReason.WRITE_PERMISSION_DENIED;
    if (/is a directory|path.*directory/i.test(s)) return ToolFailureReason.WRITE_PATH_IS_DIR;
    if (/no space|ENOSPC|disk full/i.test(s)) return ToolFailureReason.FILE_SYSTEM_ERROR;
    return ToolFailureReason.UNKNOWN;
  }

  if (toolName === 'read_mcp_resource') {
    if (/not available|no mcp manager/i.test(s)) return ToolFailureReason.MCP_SERVER_UNAVAILABLE;
    return ToolFailureReason.MCP_TOOL_FAILED;
  }

  if (toolName.startsWith('mcp__')) {
    if (/not available|no mcp manager/i.test(s)) return ToolFailureReason.MCP_SERVER_UNAVAILABLE;
    return ToolFailureReason.MCP_TOOL_FAILED;
  }

  if (toolName === 'task') {
    if (/timeout/i.test(s)) return ToolFailureReason.SUBAGENT_TIMEOUT;
    if (/abort|cancel/i.test(s)) return ToolFailureReason.SUBAGENT_ABORTED;
    return ToolFailureReason.SUBAGENT_FAILED;
  }

  if (toolName === 'search_content' || toolName === 'search_files') {
    if (/refusing search outside workspace/i.test(s)) return ToolFailureReason.READ_FILE_NOT_FOUND;
    if (/invalid regular expression|bad regex/i.test(s)) return ToolFailureReason.UNKNOWN;
    if (/file not found|ENOENT/i.test(s)) return ToolFailureReason.READ_FILE_NOT_FOUND;
    if (/permission denied/i.test(s)) return ToolFailureReason.READ_PERMISSION_DENIED;
    return ToolFailureReason.UNKNOWN;
  }

  return ToolFailureReason.UNKNOWN;
}
