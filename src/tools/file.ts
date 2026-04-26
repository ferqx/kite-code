import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Glob } from "bun";

// ============================================================================
// 工作区路径安全校验 / Workspace path safety validation
// ============================================================================

function safePath(workspace: string, filePath: string): string {
  const wsResolved = resolve(workspace);
  const resolved = resolve(wsResolved, filePath.replace(/[\\/]+/g, sep));
  const relativePath = relative(wsResolved, resolved);
  if (
    relativePath &&
    (relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath))
  ) {
    throw new Error(`Refusing path outside workspace: ${filePath}`);
  }
  return resolved;
}

// ============================================================================
// read_file
// ============================================================================

export interface ReadFileInput {
  workspace: string;
  path: string;
  offset?: number;
  limit?: number;
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
    const target = safePath(input.workspace, input.path);
    if (!existsSync(target)) {
      return {
        ok: false,
        path: input.path,
        content: "",
        totalLines: 0,
        error: `File not found: ${input.path}`,
      };
    }

    const content = readFileSync(target, "utf8");
    const allLines = content.split("\n");
    if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
      allLines.pop(); // remove trailing empty from split
    }

    const offset = input.offset ?? 1;
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
    const target = safePath(input.workspace, input.path);
    if (!existsSync(target)) {
      return { ok: false, path: input.path, error: `File not found: ${input.path}` };
    }

    const content = readFileSync(target, "utf8");

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
    const target = safePath(input.workspace, input.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, input.content, "utf8");

    const written = readFileSync(target, "utf8");
    const lineCount = written.split("\n").length - (written.endsWith("\n") ? 1 : 0);

    return {
      ok: true,
      path: input.path,
      lines: lineCount,
    };
  } catch (e) {
    return { ok: false, path: input.path, error: e instanceof Error ? e.message : String(e) };
  }
}

// ============================================================================
// search — 文件内容搜索 / File content search
// ============================================================================

export interface SearchInput {
  workspace: string;
  /** 正则或普通文本搜索模式 / Regex or plain text search pattern */
  pattern: string;
  /** 搜索路径（glob 模式），如 "src\/**\/*.ts" / Search path (glob pattern) */
  globPath?: string;
  /** 每匹配显示几行上下文 / Context lines around each match */
  contextLines?: number;
  /** 是否区分大小写（默认 false） / Case sensitive (default false) */
  caseSensitive?: boolean;
  /** 最大匹配数限制 / Max results */
  maxResults?: number;
}

export interface SearchMatch {
  file: string;
  line: number;
  content: string;
}

export interface SearchResult {
  ok: boolean;
  /** 匹配文件数 / Number of files matched */
  fileCount: number;
  /** 匹配项列表 / Match list */
  matches: SearchMatch[];
  error?: string;
}

export async function search(input: SearchInput): Promise<SearchResult> {
  try {
    const ws = resolve(input.workspace);
    const globPattern = input.globPath ? `**/${input.globPath.replace(/^\.?\//, "")}` : "**/*";

    // 简单的后缀过滤，降低搜索范围 / Simple extension filter to reduce search scope
    const sourceExts = new Set([
      ".ts", ".tsx", ".js", ".jsx", ".json", ".jsonc",
      ".md", ".txt", ".html", ".css", ".scss", ".less",
      ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
      ".c", ".h", ".cpp", ".hpp", ".yaml", ".yml", ".toml",
      ".cfg", ".ini", ".env", ".sh", ".bash", ".zsh",
      ".sql", ".xml", ".svg", ".vue", ".svelte",
    ]);

    const files: string[] = [];
    const globIter = new Glob(globPattern);
    for await (const f of globIter.scan({ cwd: ws, absolute: true, onlyFiles: true, dot: true })) {
      // 过滤 node_modules、.git / Filter node_modules, .git
      if (f.includes("/node_modules/") || f.includes("/.git/")) continue;
      const ext = f.slice(f.lastIndexOf("."));
      if (sourceExts.has(ext) || f.endsWith("package.json") || f.endsWith("tsconfig.json")) {
        files.push(f);
      }
    }

    const regex = buildSearchRegex(input.pattern, input.caseSensitive);
    const maxResults = input.maxResults ?? 50;
    const allMatches: SearchMatch[] = [];

    for (const file of files) {
      if (allMatches.length >= maxResults) break;
      try {
        const content = readFileSync(file, "utf8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length && allMatches.length < maxResults; i++) {
          if (regex.test(lines[i])) {
            const relPath = file.replace(ws + "/", "");
            let display = `${relPath}:${i + 1}: ${lines[i].slice(0, 200)}`;
            // 添加上下文 / Add context
            if (input.contextLines) {
              const ctx: string[] = [];
              for (let j = Math.max(0, i - input.contextLines); j < i; j++) {
                ctx.push(`  ${j + 1}| ${lines[j].slice(0, 150)}`);
              }
              ctx.push(`> ${i + 1}| ${lines[i].slice(0, 150)}`);
              for (let j = i + 1; j <= Math.min(lines.length - 1, i + input.contextLines); j++) {
                ctx.push(`  ${j + 1}| ${lines[j].slice(0, 150)}`);
              }
              display = ctx.join("\n");
            }
            allMatches.push({ file: relPath, line: i + 1, content: display });
          }
        }
      } catch {
        // 跳过无法读取的文件 / Skip unreadable files
      }
    }

    return {
      ok: true,
      fileCount: new Set(allMatches.map((m) => m.file)).size,
      matches: allMatches,
    };
  } catch (e) {
    return {
      ok: false,
      fileCount: 0,
      matches: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function buildSearchRegex(pattern: string, caseSensitive?: boolean): RegExp {
  try {
    // 如果 pattern 被 / / 包裹，视为正则表达式 / If pattern wrapped in / /, treat as regex
    if (pattern.startsWith("/") && pattern.lastIndexOf("/") > 0) {
      const lastSlash = pattern.lastIndexOf("/");
      const body = pattern.slice(1, lastSlash);
      const flags = pattern.slice(lastSlash + 1);
      return new RegExp(body, caseSensitive ? flags : flags.replace("i", "") + "i");
    }
    // 普通文本搜索 / Plain text search
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, caseSensitive ? "g" : "gi");
  } catch {
    // fallback: 纯文本搜索 / fallback: plain text search
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, "gi");
  }
}
