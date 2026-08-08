// ── Shell 命令风险分类共享模块 / Shared shell command risk classification module ──
//
// 本模块提供 shell 命令分类的核心函数，供 approval-policy、authorization-policy、
// tool-policy 等模块共享使用，避免重复实现。
//
// This module provides core shell command classification functions shared by
// approval-policy, authorization-policy, and tool-policy to avoid duplication.

import { isAbsolute, relative, resolve, sep } from 'node:path';

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

/** 工具调用可叠加的外部副作用 / Additive external side effects of a tool call */
export interface ToolEffects {
  /** 该调用会访问网络 / The call accesses the network */
  network?: true;
  /** 该调用会读取工作区外部 / The call reads outside the workspace */
  externalRead?: true;
  /** 该调用会写入工作区外部 / The call writes outside the workspace */
  externalWrite?: true;
  /** 静态分析无法证明该调用不会出网或外部写入 / Static analysis cannot prove local-only effects */
  uncertainEffects?: true;
}

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
    // sudo / runas (Windows) privilege escalation
    /(?:(?:^|[;&|]\s*)|\/)(?:sudo|runas)\b/.test(normalized) ||
    // rm -rf Unix variants
    /\brm\s+(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r|-r\s+-f|-f\s+-r|--recursive.*--force|--force.*--recursive)\b/.test(
      normalized,
    ) ||
    /\brm\s+-[^\s]*f\b/.test(normalized) ||
    // Windows native destructive: del /f /s, rmdir /s /q
    /\b(?:del|rmdir|rd)\s+\/[^\s]*[sq]/i.test(normalized) ||
    // Unix recursive permission/ownership changes
    /\bchmod\s+(?:-[^\s]*[rR]|--recursive)\b/.test(normalized) ||
    /\bchown\s+(?:-[^\s]*[rR]|--recursive)\b/.test(normalized) ||
    /(?:(?:^|[;&|]\s*)|\/)(?:kill|taskkill)(?:all)?\b/.test(normalized) ||
    /\bdd\b.*\bof=\/dev\//.test(normalized) ||
    /\bmkfs\b/.test(normalized) ||
    /\b(?:shutdown|reboot|halt|poweroff)\b/.test(normalized) ||
    /\binit\s+[06]\b/.test(normalized) ||
    /\bfdisk\b/.test(normalized) ||
    /\bparted\b/.test(normalized) ||
    /:\(\)\s*\{.*:.*\|.*:.*\}/.test(normalized) ||
    />\s*\/dev\/sd/.test(normalized) ||
    // Windows diskpart / format
    /\b(?:diskpart|format)\b/.test(normalized)
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
  const normalized = normalizeShell(command);
  return (
    /\b(?:curl|wget|ssh|scp|sftp|rsync|ftp|nc|ncat|telnet)\b/.test(normalized) ||
    /\bgit\s+(?:clone|fetch|pull|push|ls-remote)\b/.test(normalized) ||
    /\b(?:bun|npm|pnpm|yarn)\s+(?:install|add|remove|update|upgrade)\b/.test(normalized) ||
    /\b(?:pip|pip3|cargo|gem|go|brew|apt|apt-get|choco)\s+(?:install|update|upgrade)\b/.test(
      normalized,
    )
  );
}

/**
 * 分析 shell 调用是否可证明为仅工作区本地操作。
 * 只对白名单文件命令和本地 Git 操作给出肯定结论；其余可执行程序按严格策略要求确认。
 */
export function classifyShellEffects(command: string, workspace: string): ToolEffects {
  if (isNetworkCommand(command)) return { network: true };

  const writeTargets = extractWriteTargets(command);
  if (writeTargets === null) return { uncertainEffects: true };
  if (writeTargets.some((target) => !isWorkspacePath(target, workspace))) {
    return { externalWrite: true };
  }
  return {};
}

/**
 * 返回已知写入目标；null 表示命令可能写入但无法静态证明其范围。
 * 复杂 shell 语法同样按未知处理，避免通过组合命令绕过边界判断。
 */
function extractWriteTargets(command: string): string[] | null {
  const trimmed = command.trim();
  if (!trimmed || /[;&|`$(){}[\]*?]/.test(trimmed)) return null;

  const redirect = /(?:^|[^>])>{1,2}\s*([^\s]+)/.exec(trimmed);
  if (redirect?.[1]) return [redirect[1]];

  const tokens = trimmed.split(/\s+/);
  const [program, ...args] = tokens;
  if (!program || args.length === 0) return null;
  const paths = args.filter((arg) => !arg.startsWith('-'));

  switch (program.toLowerCase()) {
    case 'touch':
    case 'mkdir':
    case 'tee':
    case 'rm':
    case 'unlink':
      return paths.length > 0 ? paths : null;
    case 'cp':
    case 'mv':
      return paths.length >= 2 ? [paths.at(-1)!] : null;
    default:
      return null;
  }
}

function isWorkspacePath(target: string, workspace: string): boolean {
  const path = target.replace(/^['"]|['"]$/g, '');
  if (!path || path === '-' || path.startsWith('~') || path.includes('$')) return false;
  if (/^[a-z]:[\\/]/i.test(path) || /^\\{1,2}/.test(path)) return false;

  const workspaceRoot = resolve(workspace);
  const resolvedPath = resolve(workspaceRoot, path.replace(/[\\/]+/g, '/'));
  const relativePath = relative(workspaceRoot, resolvedPath);
  return !(
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  );
}

// ── rm -rf 安全分类 / rm -rf safety classification ──
// rm -rf on non-critical paths is treated as write_file, not destructive.
// Only workspace root and critical system paths are denied outright.
// Subdirectories (node_modules, src/) are downgraded → auto-review judges.

/**
 * 关键系统路径前缀 — 删除这些路径不可逆。
 * 统一规范化为小写正斜杠格式，支持跨平台匹配。
 *
 * Critical system path prefixes — deleting these is irreversible.
 * Normalized to lowercase forward-slash form for cross-platform matching.
 */
const CRITICAL_SYSTEM_PREFIXES: ReadonlyArray<string> = [
  // Unix
  '/etc/',
  '/etc',
  '/boot/',
  '/boot',
  '/bin/',
  '/bin',
  '/sbin/',
  '/sbin',
  '/lib/',
  '/lib',
  '/lib64/',
  '/lib64',
  '/sys/',
  '/sys',
  '/proc/',
  '/proc',
  '/dev/',
  '/dev',
  // Windows — case-insensitive, stored lowercased
  'c:/windows/',
  'c:/windows',
  'c:/windows/system32/',
  'c:/windows/system32',
];

/** 规范化路径为小写正斜杠格式，用于跨平台比较 / Normalize path to lowercase forward-slash form for cross-platform comparison */
function normalizePathForComparison(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase();
}

function isCriticalSystemPath(target: string): boolean {
  const path = target.replace(/^['"]|['"]$/g, '');
  if (!path) return false;
  // Normalize directly without resolve() — must work cross-platform because
  // the command might target a remote system or be tested on a different OS.
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  // rm -rf / or rm -rf C:\ is always denied
  if (normalized === '/' || /^[a-z]:\/$/.test(normalized)) return true;
  return CRITICAL_SYSTEM_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`),
  );
}

/** 提取 rm 命令的删除目标，自动剥离 sudo 前缀 / Extract rm targets, stripping sudo prefix */
function extractRmTargets(command: string): string[] | null {
  // Strip sudo / runas prefix: "sudo rm -rf /x" → "rm -rf /x"
  const withoutSudo = command.replace(/^(?:sudo|runas)\s+/i, '').trim();
  if (!withoutSudo || !/\brm\b/.test(normalizeShell(withoutSudo))) return null;
  return extractWriteTargets(withoutSudo);
}

/**
 * 检查 rm -rf 是否直接删除了工作区根目录本身（`.` 或绝对路径）。
 * 只拒绝删除整个工作区；子目录（src/、node_modules 等）降级为 write_file 走 auto-review。
 */
export function isDestructiveRmOnWorkspace(command: string, workspace: string): boolean {
  if (!isDestructiveShellCommand(command)) return false;
  const targets = extractRmTargets(command);
  if (!targets || targets.length === 0) return false;
  const workspaceRoot = normalizePathForComparison(resolve(workspace));
  return targets.some((t) => {
    const path = t.replace(/^['"]|['"]$/g, '');
    // rm -rf . at workspace root → deny
    if (path === '.') return true;
    // rm -rf <absolute workspace path> → deny (handle Unix /x/y and Windows C:\x\y)
    if (isAbsolute(path) && normalizePathForComparison(resolve('/', path)) === workspaceRoot)
      return true;
    return false;
  });
}

/**
 * 检查 rm -rf 是否删除了关键系统路径。
 * 删除 /etc、/bin、/boot 等不可逆，必须拒绝。
 */
export function isDestructiveRmOnCriticalPaths(command: string): boolean {
  if (!isDestructiveShellCommand(command)) return false;
  const targets = extractRmTargets(command);
  if (!targets || targets.length === 0) return false;
  return targets.some((t) => isCriticalSystemPath(t));
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

const READ_ONLY_COMMANDS = new Set([
  'awk',
  'cat',
  'cut',
  'du',
  'echo',
  'file',
  'find',
  'grep',
  'head',
  'ls',
  'nl',
  'pwd',
  'rg',
  'sed',
  'sort',
  'stat',
  'tail',
  'test',
  'tr',
  'uniq',
  'wc',
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  'branch',
  'diff',
  'grep',
  'log',
  'ls-files',
  'show',
  'status',
]);

const LOCAL_RUNTIME_VERSION_COMMANDS = new Set(['bun', 'node', 'npm', 'pnpm', 'yarn']);

/** Conservative command-shape classifier used by shell approval and ToolSpec effects. */
export function isReadOnlyShellCommand(command: string): boolean {
  const trimmed = (command ?? '').trim();
  if (!trimmed || /(^|[^>])>{1,2}(?!&[12]|\s*\/dev\/null)(?:$|[^>])/.test(trimmed)) {
    return false;
  }
  if (/\$\(/.test(trimmed) || /`/.test(trimmed)) return false;
  const stripped = trimmed.replace(/&&/g, '').replace(/\d?>&\d?/g, '');
  if (stripped.includes('&')) return false;
  return splitReadOnlySegments(trimmed).every(isReadOnlySegment);
}

function splitReadOnlySegments(command: string): string[] {
  return command
    .split(/\s*(?:\|\||&&|[|;])\s*/g)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function isReadOnlySegment(segment: string): boolean {
  const tokens = segment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const command = stripShellQuotes(tokens[0] ?? '').toLowerCase();
  if (!command) return false;
  const portableCommand = command.replace(/\.(?:cmd|exe)$/i, '');
  if (LOCAL_RUNTIME_VERSION_COMMANDS.has(portableCommand)) {
    return tokens.length === 2 && ['--version', '-v'].includes(stripShellQuotes(tokens[1] ?? ''));
  }
  if (command === 'git') {
    return READ_ONLY_GIT_SUBCOMMANDS.has(stripShellQuotes(tokens[1] ?? '').toLowerCase());
  }
  if (command === 'sed') {
    return (
      READ_ONLY_COMMANDS.has(command) &&
      !tokens.some((token) => /^-.*i/.test(stripShellQuotes(token)))
    );
  }
  if (command === 'find') {
    return (
      READ_ONLY_COMMANDS.has(command) &&
      !tokens.some((token) => ['-exec', '-execdir', '-delete'].includes(stripShellQuotes(token)))
    );
  }
  if (command === 'awk') {
    return READ_ONLY_COMMANDS.has(command) && !/\bsystem\s*\(/.test(segment);
  }
  if (command === 'xargs') {
    const invokedIndex = tokens.findIndex((token, index) => index > 0 && !token.startsWith('-'));
    const invoked =
      invokedIndex > 0 ? stripShellQuotes(tokens[invokedIndex] ?? '').toLowerCase() : '';
    return Boolean(invoked) && READ_ONLY_COMMANDS.has(invoked);
  }
  return READ_ONLY_COMMANDS.has(command);
}

function stripShellQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, '');
}
