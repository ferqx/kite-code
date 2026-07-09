// ── Shell 命令风险分类共享模块 / Shared shell command risk classification module ──
//
// 本模块提供 shell 命令分类的核心函数，供 approval-policy、authorization-policy、
// tool-policy 等模块共享使用，避免重复实现。
//
// This module provides core shell command classification functions shared by
// approval-policy, authorization-policy, and tool-policy to avoid duplication.

/** 工具风险分类 / Tool risk classification */
export type ToolRisk =
  | 'read'
  | 'plan'
  | 'write_file'
  | 'execute_code'
  | 'destructive'
  | 'network'
  | 'vcs_mutation'
  | 'mcp'
  | 'unknown';

// ── 内部辅助 / Internal helpers ──

/** 规范化 shell 命令为小写、单空白分隔 / Normalize shell command to lowercase with single spaces */
export function normalizeShell(command: string): string {
  return (command ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// ── Shell 命令分类函数 / Shell command classification functions ──

/**
 * 检测 shell 命令是否具有破坏性（不可逆的数据丢失或系统级操作）。
 *
 * Check whether a shell command is destructive (irreversible data loss or system-level operations).
 */
export function isDestructiveShellCommand(command: string): boolean {
  const normalized = normalizeShell(command);
  return (
    /(?:(?:^|[;&|]\s*)|\/)sudo\b/.test(normalized) ||
    /\brm\s+(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r|-r\s+-f|-f\s+-r|--recursive.*--force|--force.*--recursive)\b/.test(
      normalized,
    ) ||
    /\brm\s+-[^\s]*f\b/.test(normalized) ||
    /\bchmod\s+(?:-[^\s]*[rR]|--recursive)\b/.test(normalized) ||
    /\bchown\s+(?:-[^\s]*[rR]|--recursive)\b/.test(normalized) ||
    /(?:(?:^|[;&|]\s*)|\/)kill(?:all)?\b/.test(normalized) ||
    /\bdd\b.*\bof=\/dev\//.test(normalized) ||
    /\bmkfs\b/.test(normalized) ||
    /\b(?:shutdown|reboot|halt|poweroff)\b/.test(normalized) ||
    /\binit\s+[06]\b/.test(normalized) ||
    /\bfdisk\b/.test(normalized) ||
    /\bparted\b/.test(normalized) ||
    /:\(\)\s*\{.*:.*\|.*:.*\}/.test(normalized) ||
    />\s*\/dev\/sd/.test(normalized)
  );
}

/** 检测命令是否为版本控制变更操作（如 git add/commit/push 等）/ Check if command is a VCS mutation */
export function isVcsMutationCommand(command: string): boolean {
  return /\bgit\s+(?:add|clone|commit|checkout|switch|merge|rebase|tag|restore|stash|pull|fetch|push|reset|clean)\b/.test(
    normalizeShell(command),
  );
}

/** 检测命令是否可能写入文件 / Check if command may write files */
export function isWriteLikeShellCommand(command: string): boolean {
  const normalized = normalizeShell(command);
  return (
    /(^|[^>])>{1,2}(?!&[12])(?:$|[^>])/.test(normalized) ||
    /(?:^|[;&|]\s*)(?:cp|mv|mkdir|touch|tee|rm|unlink)\b/.test(normalized) ||
    /\b(?:bun|npm|pnpm|yarn)\s+(?:install|add|remove|update)\b/.test(normalized) ||
    /\b(?:pip|pip3|cargo|gem|go|brew|apt|apt-get|choco)\s+install\b/.test(normalized)
  );
}

/** 检测命令是否访问网络 / Check if command accesses the network */
export function isNetworkCommand(command: string): boolean {
  return /\b(?:curl|wget)\b/.test(normalizeShell(command));
}

/**
 * 对 shell 命令进行风险分类。
 *
 * Classify the risk level of a shell command.
 */
export function classifyShellRisk(command: string): ToolRisk {
  if (isDestructiveShellCommand(command)) return 'destructive';
  if (isVcsMutationCommand(command)) return 'vcs_mutation';
  if (isWriteLikeShellCommand(command)) return 'write_file';
  if (isNetworkCommand(command)) return 'network';
  return 'execute_code';
}
