// ============================================================================
// 共享路径工具 — MSYS2 路径转换 / Shared path utilities — MSYS2 path conversion
// ============================================================================

/** 将单个 MSYS2/Cygwin 驱动器路径转为 Windows 路径，仅 Windows 平台生效。
 *  /d/foo/bar → D:\foo\bar
 *  Convert a single MSYS2/Cygwin drive-letter path to Windows format (Windows only). */
export function msys2ToWindowsPath(filePath: string): string {
  if (process.platform !== "win32") return filePath;
  const m = filePath.match(/^\/([a-zA-Z])(?:\/|$)(.*)$/);
  if (!m) return filePath;
  return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, "\\")}`;
}

/** 在任意文本中查找并转换 MSYS2 绝对路径为 Windows 路径，仅 Windows 平台生效。
 *  /d/app/foo → D:\app\foo, /c/Windows → C:\Windows 等。
 *  Normalize MSYS2 absolute paths embedded in arbitrary text to Windows format (Windows only).
 *  /d/app/foo → D:\app\foo, /c/Windows → C:\Windows, etc. */
export function normalizeMsys2PathsInText(text: string): string {
  if (process.platform !== "win32") return text;
  // /X/path — single-letter drive followed by / and one or more path segments.
  // Delimiters before: start-of-string, whitespace, quotes, parens, brackets, colon, semicolon, equals.
  // Delimiters after: whitespace, quotes, backtick, dollar, ampersand, pipe, angle brackets, parens, brackets, semicolon.
  return text.replace(
    /(^|[\s"'(\[{:;=])\/([a-zA-Z])(\/[^\s"'`$&|<>()\[\]{};]+)/g,
    (_full, prefix: string, drive: string, path: string) =>
      `${prefix}${drive.toUpperCase()}:${path.replace(/\//g, "\\")}`,
  );
}
