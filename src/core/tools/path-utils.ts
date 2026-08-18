// ============================================================================
// 共享路径工具 — MSYS2 路径转换 / Shared path utilities — MSYS2 path conversion
// ============================================================================

import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/** Expand `~` or a `~/...` / `~\\...` path against the current user's home. */
export function expandHomeRelativePath(filePath: string): string {
  if (filePath === '~') return homedir();
  if (/^~[\\/]/u.test(filePath)) return resolve(homedir(), filePath.slice(2));
  return filePath;
}

/**
 * Resolve filesystem aliases in the existing prefix while retaining any
 * non-existent suffix. This keeps policy checks and execution aligned for
 * paths such as macOS `/var/...` and `/private/var/...`, and for symlinked
 * workspace roots.
 */
export function canonicalPathForComparison(filePath: string): string {
  const absolute = resolve(filePath);
  let nearest = absolute;
  while (!existsSync(nearest)) {
    const parent = dirname(nearest);
    if (parent === nearest) break;
    nearest = parent;
  }
  const canonicalNearest = realpathSync(nearest);
  const suffix = relative(nearest, absolute);
  return normalizePathCase(resolve(canonicalNearest, suffix));
}

/** Return whether target resolves to the workspace itself or one of its descendants. */
export function isPathInsideWorkspace(workspace: string, target: string): boolean {
  const workspacePath = canonicalPathForComparison(workspace);
  const targetPath = canonicalPathForComparison(target);
  const rel = relative(workspacePath, targetPath);
  return rel === '' || (!!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function normalizePathCase(filePath: string): string {
  return process.platform === 'win32' ? filePath.toLowerCase() : filePath;
}

/** 将单个 MSYS2/Cygwin 驱动器路径转为 Windows 路径，仅 Windows 平台生效。
 *  /d/foo/bar → D:\foo\bar
 *  Convert a single MSYS2/Cygwin drive-letter path to Windows format (Windows only). */
export function msys2ToWindowsPath(filePath: string): string {
  if (process.platform !== 'win32') return filePath;
  const m = filePath.match(/^\/([a-zA-Z])(?:\/|$)(.*)$/);
  if (!m) return filePath;
  return `${m[1]!.toUpperCase()}:\\${m[2]!.replace(/\//g, '\\')}`;
}

/** 在任意文本中查找并转换 MSYS2 绝对路径为 Windows 路径，仅 Windows 平台生效。
 *  /d/app/foo → D:\app\foo, /c/Windows → C:\Windows 等。
 *  Normalize MSYS2 absolute paths embedded in arbitrary text to Windows format (Windows only).
 *  /d/app/foo → D:\app\foo, /c/Windows → C:\Windows, etc. */
export function normalizeMsys2PathsInText(text: string): string {
  if (process.platform !== 'win32') return text;
  // /X/path — single-letter drive followed by / and one or more path segments.
  // Delimiters before: start-of-string, whitespace, quotes, parens, brackets, colon, semicolon, equals.
  // Delimiters after: whitespace, quotes, backtick, dollar, ampersand, pipe, angle brackets, parens, brackets, semicolon.
  return text.replace(
    /(^|[\s"'([{:;=])\/([a-zA-Z])(\/[^\s"'`$&|<>()[\]{};]+)/g,
    (_full, prefix: string, drive: string, path: string) =>
      `${prefix}${drive.toUpperCase()}:${path.replace(/\//g, '\\')}`,
  );
}

/**
 * Convert literal MSYS2/Cygwin drive-path tokens in a Windows shell command to
 * the mixed path form understood by native Windows executables.
 *
 * This intentionally rewrites only a drive prefix at a shell-token boundary:
 * `/d/work` becomes `D:/work`, while URLs, `/dev/null`, relative paths, and
 * ordinary word fragments remain unchanged. Forward slashes are retained so
 * the transformed command remains safe to parse as POSIX shell syntax.
 */
export function normalizeMsys2DrivePathsInShellCommand(command: string): string {
  if (process.platform !== 'win32') return command;
  const boundary = String.raw`[\s"'([{;=<>|&]`;
  return command.replace(
    new RegExp(`(^|${boundary})/([a-zA-Z])(?=/)`, 'g'),
    (_full, prefix: string, drive: string) => `${prefix}${drive.toUpperCase()}:`,
  );
}
