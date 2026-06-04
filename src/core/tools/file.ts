import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { homedir } from "node:os";

// ============================================================================
// 路径解析 — 相对路径基于 workspace，绝对路径原样使用，`~` 展开为 HOME
// Path resolution — relative paths relative to workspace, absolute paths pass through, `~` expands to HOME
// ============================================================================

function resolvePath(workspace: string, filePath: string): string {
  const normalized = filePath.replace(/[\\/]+/g, sep);
  // 展开 ~ 为 HOME，与 shell 行为一致 / Expand ~ to HOME, matching shell behavior
  const expanded =
    normalized === "~"
      ? homedir()
      : normalized.startsWith(`~${sep}`)
        ? homedir() + normalized.slice(1)
        : normalized;
  return resolve(workspace, expanded);
}

// ============================================================================
// read_file
// ============================================================================

export interface ReadFileInput {
  workspace: string;
  path: string;
  offset?: number;
  limit?: number;
  /** 强制读取二进制文件（默认拒绝） / Force reading a binary file (rejected by default) */
  force?: boolean;
}

export interface ReadFileResult {
  ok: boolean;
  path: string;
  content: string;
  totalLines: number;
  fromLine?: number;
  toLine?: number;
  error?: string;
}

export function readFile(input: ReadFileInput): ReadFileResult {
  try {
    const target = resolvePath(input.workspace, input.path);
    if (!existsSync(target)) {
      return {
        ok: false,
        path: input.path,
        content: "",
        totalLines: 0,
        error: `File not found: ${input.path}`,
      };
    }

    const raw = readFileSync(target);
    // 二进制文件检测：检查 NUL byte / Binary file detection: check for NUL byte
    if (!input.force && raw.includes(0)) {
      return {
        ok: false,
        path: input.path,
        content: "",
        totalLines: 0,
        error: `Binary file detected: ${input.path}. Use force: true to read anyway.`,
      };
    }
    const content = raw.toString("utf8");
    const allLines = content.split("\n");
    if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
      allLines.pop(); // remove trailing empty from split
    }

    const offset = input.offset && input.offset > 0 ? input.offset : 1;
    const limit = input.limit ?? allLines.length;
    const fromLine = Math.max(1, offset);
    const toLine = Math.min(allLines.length, offset + limit - 1);

    const selected = allLines.slice(fromLine - 1, toLine);

    // 每行加上行号 / Add line numbers to each line
    const numbered = selected
      .map((line, idx) => {
        const lineNum = String(fromLine + idx).padStart(String(toLine).length, " ");
        return `${lineNum}|${line}`;
      })
      .join("\n");

    return {
      ok: true,
      path: input.path,
      content: numbered,
      totalLines: allLines.length,
      fromLine,
      toLine,
    };
  } catch (e) {
    return {
      ok: false,
      path: input.path,
      content: "",
      totalLines: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ============================================================================
// edit_file — 精确字符串替换 / Exact string replacement
// ============================================================================

export interface EditFileInput {
  workspace: string;
  path: string;
  oldString: string;
  newString: string;
  /** 是否替换所有匹配项 / Replace all occurrences */
  replaceAll?: boolean;
  /** 匹配模式：exact 逐字匹配，trimmed 逐行 trim 首尾空白后匹配 / Match mode: exact for verbatim match, trimmed for per-line whitespace trimming */
  matchMode?: "exact" | "trimmed";
}

export interface EditFileResult {
  ok: boolean;
  path: string;
  /** 替换后的完整文件内容 / Full file content after replacement */
  content?: string;
  /** 替换发生的行范围 / Line range where replacement occurred */
  fromLine?: number;
  toLine?: number;
  /** 替换了多少处 / How many replacements made */
  replacements?: number;
  error?: string;
}

export function editFile(input: EditFileInput): EditFileResult {
  try {
    const target = resolvePath(input.workspace, input.path);
    if (!existsSync(target)) {
      return { ok: false, path: input.path, error: `File not found: ${input.path}` };
    }

    const content = readFileSync(target, "utf8");

    // 使用匹配模式查找 old_string / Use match mode to find old_string
    if (input.matchMode === "trimmed") {
      return editFileTrimmed(target, input.path, content, input.oldString, input.newString, input.replaceAll);
    }

    // 查找 old_string / Find old_string
    const index = content.indexOf(input.oldString);
    if (index === -1) {
      // 尝试去除尾部空白后匹配 / Try matching after trimming trailing whitespace
      const trimmedOld = input.oldString.trimEnd();
      const trimmedIndex = content.indexOf(trimmedOld);
      if (trimmedIndex === -1) {
        const snippet = input.oldString.slice(0, 100).replace(/\n/g, "\\n");
        return {
          ok: false,
          path: input.path,
          error: `old_string not found in ${input.path}: "${snippet}..."`,
        };
      }
      // 使用 trimmed 匹配 / Use trimmed match
      return performReplace(input.path, target, content, trimmedOld, input.newString, input.replaceAll, trimmedIndex);
    }

    // 检查是否多处匹配 / Check for multiple matches
    const secondIndex = content.indexOf(input.oldString, index + 1);
    if (secondIndex !== -1 && !input.replaceAll) {
      // 有重复匹配且未指定 replaceAll，报错 / Duplicate match and replaceAll not set, error
      const snippet = input.oldString.slice(0, 100).replace(/\n/g, "\\n");
      return {
        ok: false,
        path: input.path,
        error: `old_string found ${content.split(input.oldString).length - 1} times in ${input.path}. Use replaceAll: true or make old_string more specific. First match at offset ${index}.`,
      };
    }

    return performReplace(input.path, target, content, input.oldString, input.newString, input.replaceAll, index);
  } catch (e) {
    return { ok: false, path: input.path, error: e instanceof Error ? e.message : String(e) };
  }
}

/** trimmed 模式匹配：逐行 trim 首尾空白后定位 old_string / Trimmed mode: locate old_string by trimming each line */
function editFileTrimmed(
  target: string,
  path: string,
  content: string,
  oldString: string,
  newString: string,
  replaceAll?: boolean,
): EditFileResult {
  const oldLines = oldString.split("\n");
  const trimmedOldLines = oldLines.map((l) => l.trim());
  const contentLines = content.split("\n");
  const trimmedContentLines = contentLines.map((l) => l.trim());

  // 在 trimmed 内容行中搜索 trimmed old_string / Search for trimmed old_string in trimmed content lines
  let matchLine = -1;
  for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
    let mismatch = false;
    for (let j = 0; j < oldLines.length; j++) {
      if (trimmedContentLines[i + j] !== trimmedOldLines[j]) {
        mismatch = true;
        break;
      }
    }
    if (!mismatch) {
      matchLine = i;
      break;
    }
  }

  if (matchLine === -1) {
    const snippet = oldString.slice(0, 100).replace(/\n/g, "\\n");
    return {
      ok: false,
      path,
      error: `old_string not found in ${path} (trimmed mode): "${snippet}..."`,
    };
  }

  // 计算原始内容中的字符偏移 / Calculate character offset in original content
  let charOffset = 0;
  for (let k = 0; k < matchLine; k++) {
    charOffset += contentLines[k].length + 1; // +1 for newline
  }

  // 在原始内容中逐行定位 old_string 的精确起始位置 / Locate exact start of old_string in original content
  const originalOldLines = contentLines.slice(matchLine, matchLine + oldLines.length).join("\n");

  // 检查多匹配 / Check for duplicate matches in trimmed mode
  if (!replaceAll) {
    let matchCount = 0;
    for (let i = 0; i <= contentLines.length - oldLines.length; i++) {
      let mismatch = false;
      for (let j = 0; j < oldLines.length; j++) {
        if (trimmedContentLines[i + j] !== trimmedOldLines[j]) {
          mismatch = true;
          break;
        }
      }
      if (!mismatch) matchCount++;
    }
    if (matchCount > 1) {
      const snippet = oldString.slice(0, 100).replace(/\n/g, "\\n");
      return {
        ok: false,
        path,
        error: `old_string found ${matchCount} times in ${path} (trimmed mode). Use replaceAll: true or make old_string more specific.`,
      };
    }
  }

  return performReplaceTrimmed(path, target, content, contentLines, matchLine, oldLines.length, newString, replaceAll, charOffset, trimmedOldLines);
}

/** trimmed 模式的文件替换 / File replacement in trimmed mode */
function performReplaceTrimmed(
  path: string,
  target: string,
  content: string,
  contentLines: string[],
  matchLine: number,
  oldLineCount: number,
  newStr: string,
  replaceAll: boolean | undefined,
  charOffset: number,
  userTrimmedOldLines: string[],
): EditFileResult {
  let newContent: string;

  if (replaceAll) {
    const trimmedContentLines = contentLines.map((l) => l.trim());
    const trimmedOldLines = userTrimmedOldLines;
    const parts: string[] = [];
    let i = 0;
    while (i <= contentLines.length - oldLineCount) {
      let match = true;
      for (let j = 0; j < oldLineCount; j++) {
        if (trimmedContentLines[i + j] !== trimmedOldLines[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        parts.push(newStr);
        i += oldLineCount;
      } else {
        parts.push(contentLines[i]);
        i++;
      }
    }
    // 添加剩余行 / Add remaining lines
    for (; i < contentLines.length; i++) {
      parts.push(contentLines[i]);
    }
    newContent = parts.join("\n");
  } else {
    const before = contentLines.slice(0, matchLine);
    const after = contentLines.slice(matchLine + oldLineCount);
    newContent = [...before, newStr, ...after].join("\n");
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, newContent, "utf8");

  // 计算行号 / Calculate line numbers
  const fromLine = matchLine + 1;
  const newLines = newStr.split("\n").length;
  const toLine = fromLine + Math.max(0, newLines - 1);

  return {
    ok: true,
    path,
    content: newContent,
    fromLine,
    toLine,
    replacements: replaceAll ? undefined : 1,
  };
}

function performReplace(
  path: string,
  target: string,
  content: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean | undefined,
  firstIndex: number,
): EditFileResult {
  let newContent: string;
  let replacements = 1;

  if (replaceAll) {
    const parts = content.split(oldStr);
    replacements = parts.length - 1;
    newContent = parts.join(newStr);
  } else {
    newContent = content.slice(0, firstIndex) + newStr + content.slice(firstIndex + oldStr.length);
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, newContent, "utf8");

  // 计算行号 / Calculate line numbers
  const before = content.slice(0, firstIndex).split("\n");
  const fromLine = before.length;
  const newLines = newStr.split("\n").length;
  const toLine = fromLine + Math.max(0, newLines - 1);

  return {
    ok: true,
    path,
    content: newContent,
    fromLine,
    toLine,
    replacements,
  };
}

// ============================================================================
// write_file — 创建或覆写文件 / Create or overwrite file
// ============================================================================

export interface WriteFileInput {
  workspace: string;
  path: string;
  content: string;
  /** Write mode: overwrite (default) replaces entire file, append adds to end / 模式：overwrite 覆盖，append 追加 */
  mode?: "overwrite" | "append";
}

export interface WriteFileResult {
  ok: boolean;
  path: string;
  /** 文件行数 / Number of lines written */
  lines?: number;
  error?: string;
}

export function writeFile(input: WriteFileInput): WriteFileResult {
  try {
    const target = resolvePath(input.workspace, input.path);
    mkdirSync(dirname(target), { recursive: true });

    if (input.mode === "append") {
      appendFileSync(target, input.content, "utf8");
    } else {
      writeFileSync(target, input.content, "utf8");
    }

    // 直接对写入内容计算行数，避免 TOCTOU 竞态（写入后重新读取可能被其他进程修改）
    // Count lines from the written content directly to avoid TOCTOU race condition
    const lineCount = input.content.split("\n").length - (input.content.endsWith("\n") ? 1 : 0);

    return {
      ok: true,
      path: input.path,
      lines: lineCount,
    };
  } catch (e) {
    return { ok: false, path: input.path, error: e instanceof Error ? e.message : String(e) };
  }
}
