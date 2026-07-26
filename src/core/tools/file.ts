import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { readFile as readFileBufferAsync } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { msys2ToWindowsPath } from './path-utils';

// ============================================================================
// 公用 — 换行符正规化 / Common — line ending normalization
// ============================================================================

/** Windows (\r\n) / 老 Mac (\r) → Unix (\n) */
export function normalizeEOL(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// ============================================================================
// 路径解析 / Path resolution
// ============================================================================

export function resolvePath(
  workspace: string,
  filePath: string,
  opts?: { allowExternal?: boolean },
): string {
  // MSYS2 路径先于 normalize 处理：/d/foo → D:\foo
  const asWindows = msys2ToWindowsPath(filePath);
  const normalized = asWindows.replace(/[\\/]+/g, sep);
  if (!normalized || normalized === '~' || normalized.startsWith(`~${sep}`)) {
    if (opts?.allowExternal) return resolve(filePath);
    throw new Error(`Path is outside workspace: ${filePath}`);
  }
  if (isAbsolute(normalized)) {
    if (opts?.allowExternal) return resolve(normalized);
    // 绝对路径但可能在工作区内——先解析再验证 / Absolute path may be inside workspace — resolve first
    const resolved = resolve(normalized);
    try {
      assertInsideWorkspace(workspace, resolved, filePath);
      return resolved;
    } catch {
      throw new Error(`Path is outside workspace: ${filePath}`);
    }
  }
  const target = resolve(workspace, normalized);
  if (!opts?.allowExternal) {
    assertInsideWorkspace(workspace, target, filePath);
  }
  return target;
}

function assertInsideWorkspace(workspace: string, target: string, originalPath: string): void {
  const workspaceReal = realpathSync(workspace);
  const nearest = nearestExistingPath(target);
  const nearestReal = realpathSync(nearest);
  if (!isPathInside(workspaceReal, nearestReal)) {
    throw new Error(`Path is outside workspace: ${originalPath}`);
  }
  if (existsSync(target)) {
    const targetReal = realpathSync(target);
    if (!isPathInside(workspaceReal, targetReal)) {
      throw new Error(`Path is outside workspace: ${originalPath}`);
    }
  }
}

function nearestExistingPath(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return parent;
    current = parent;
  }
  return current;
}

function isPathInside(parent: string, child: string): boolean {
  const parentNorm = normalizeForCompare(parent);
  const childNorm = normalizeForCompare(child);
  const rel = relative(parentNorm, childNorm);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

function normalizeForCompare(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

// ============================================================================
// isTextByte — 判断单字节是否属于可读文本文件
// isTextByte — classify a single byte as text or binary
//
// 文本 (text)：TAB(0x09)、LF(0x0A)、CR(0x0D)、可打印 ASCII (0x20–0x7E)、
//              UTF-8 多字节 (0x80–0xFD，包涵 continuation bytes 0x80–0xBF
//              和 leading bytes 0xC0–0xFD)
// 非文本 (binary)：其余控制字符 (0x00–0x08, 0x0B–0x0C, 0x0E–0x1F)、
//                  DEL(0x7F) 以及 UTF-8 中无效的 0xFE–0xFF
//
// VT(0x0B) 和 FF(0x0C) 归类为非文本：二者在现代文本文件中几乎不存在；
// 若真有用 FF 分页的遗留文件，模型可用 force: true 重试，成本远低于
// 把二进制垃圾喂给模型。
// ============================================================================

function isTextByte(b: number): boolean {
  return (
    b === 0x09 ||
    b === 0x0a ||
    b === 0x0d || // TAB, LF, CR
    (b >= 0x20 && b <= 0x7e) || // printable ASCII
    (b >= 0x80 && b <= 0xfd) // UTF-8 multi-byte
  );
}

// ============================================================================
// readTextContent — 共享的文件读取边界
// Shared file reading boundary: encoding detection, BOM stripping, binary check,
// line-ending normalization. Exported for unit testing.
//
// 同步入口 readTextContent 与异步入口 readTextContentAsync 共享同一个
// decodeTextBuffer 解码核心，保证两条路径的编码检测、二进制检测与换行正规化
// 行为完全一致。批量读取（如 search_content 全工作区扫描）必须走异步入口，
// 否则同步 I/O 会长时间占用事件循环，阻塞 TUI 动画渲染。
// The sync entry (readTextContent) and async entry (readTextContentAsync) share
// the same decodeTextBuffer core so encoding detection, binary detection and
// line-ending normalization behave identically. Bulk reads (e.g. search_content
// walking a whole workspace) must use the async entry so synchronous I/O does
// not hold the event loop and block TUI animation rendering.
// ============================================================================

interface TextContent {
  ok: true;
  content: string;
  totalLines: number;
}

interface TextContentError {
  ok: false;
  error: string;
  totalLines: 0;
}

function decodeTextBuffer(
  raw: Buffer,
  filePath: string,
  opts?: { force?: boolean },
): TextContent | TextContentError {
  // 编码检测 / Encoding detection — 在二进制检测之前执行。
  // UTF-16 文本文件中 NUL byte 比例天然高（ASCII 字符每两字节一个 NUL），
  // 必须先识别 BOM 确定编码，再决定是否做二进制检测。
  // Encoding detection before binary check: UTF-16 text files have high NUL byte
  // ratio by design (one NUL per ASCII char). BOM must be recognized first.
  let content: string;
  let hasBom = false;
  if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
    // UTF-16LE BOM
    hasBom = true;
    content = raw.toString('utf16le');
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  } else if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
    // UTF-16BE BOM
    hasBom = true;
    const swapped = Buffer.alloc(raw.length);
    for (let i = 0; i + 1 < raw.length; i += 2) {
      swapped[i] = raw[i + 1]!;
      swapped[i + 1] = raw[i]!;
    }
    content = swapped.toString('utf16le');
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  } else {
    // UTF-8（可能带 BOM，也可能不带 BOM）
    content = raw.toString('utf8');
    if (content.charCodeAt(0) === 0xfeff) {
      hasBom = true;
      content = content.slice(1);
    }
  }

  // 二进制检测 / Binary detection
  // 有 BOM 的文件显式声明了文本编码，绕过启发式检测。
  // Files with BOM explicitly declare text encoding — skip heuristic check.
  if (!opts?.force && !hasBom) {
    const sampleLen = Math.min(raw.length, 8192);
    let nonText = 0;
    for (let i = 0; i < sampleLen; i++) {
      if (!isTextByte(raw[i]!)) nonText++;
    }
    if (nonText > sampleLen * 0.3) {
      return {
        ok: false,
        error: `Binary file detected: ${filePath}. It cannot be read as text. Tell the user the file appears binary and ask how they want to proceed.`,
        totalLines: 0,
      };
    }
  }

  // 换行符正规化 / Line ending normalization
  content = normalizeEOL(content);

  const allLines = content.split('\n');
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
    allLines.pop();
  }

  return { ok: true, content, totalLines: allLines.length };
}

export function readTextContent(
  workspace: string,
  filePath: string,
  opts?: { force?: boolean; allowExternal?: boolean },
): TextContent | TextContentError {
  const target = resolvePath(workspace, filePath, { allowExternal: opts?.allowExternal });
  if (!existsSync(target)) {
    return { ok: false, error: `File not found: ${filePath}`, totalLines: 0 };
  }

  return decodeTextBuffer(readFileSync(target), filePath, opts);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * readTextContent 的异步入口：行为与同步版本一致（同一解码核心、同样的
 * 错误消息），但通过 fs.promises.readFile 让出事件循环。供 search_content
 * 等需要遍历读取大量文件的调用方使用，避免同步 I/O 长时间阻塞 TUI 渲染。
 * Async entry for readTextContent: identical behavior (same decode core, same
 * error messages) that yields the event loop via fs.promises.readFile. Used by
 * callers that read many files (e.g. search_content) so synchronous I/O does
 * not block TUI rendering for extended periods.
 */
export async function readTextContentAsync(
  workspace: string,
  filePath: string,
  opts?: { force?: boolean; allowExternal?: boolean },
): Promise<TextContent | TextContentError> {
  const target = resolvePath(workspace, filePath, { allowExternal: opts?.allowExternal });
  let raw: Buffer;
  try {
    raw = await readFileBufferAsync(target);
  } catch (error) {
    if (isNotFound(error)) {
      return { ok: false, error: `File not found: ${filePath}`, totalLines: 0 };
    }
    throw error;
  }
  return decodeTextBuffer(raw, filePath, opts);
}

// ============================================================================
// read_file
// ============================================================================

export interface ReadFileInput {
  workspace: string;
  path: string;
  offset?: number;
  limit?: number;
  force?: boolean;
  allowExternal?: boolean;
}

export interface ReadFileResult {
  ok: boolean;
  path: string;
  content: string;
  totalLines: number;
  fromLine?: number;
  toLine?: number;
  error?: string;
  /** 内部字段：换行正规化后的原始文本（读取状态指纹输入，不作模型输出）。
   *  Internal: raw normalized text (read-state fingerprint input, not model output). */
  rawContent?: string;
}

export function readFile(input: ReadFileInput): ReadFileResult {
  try {
    const result = readTextContent(input.workspace, input.path, {
      force: input.force,
      allowExternal: input.allowExternal,
    });
    if (!result.ok) {
      return { ok: false, path: input.path, content: '', totalLines: 0, error: result.error };
    }

    const allLines = result.content.split('\n');

    const offset = input.offset && input.offset > 0 ? input.offset : 1;
    const limit = input.limit ?? allLines.length;
    const fromLine = Math.max(1, offset);
    const toLine = Math.min(allLines.length, offset + limit - 1);

    const selected = allLines.slice(fromLine - 1, toLine);

    const numbered = selected
      .map((line, idx) => {
        const lineNum = String(fromLine + idx).padStart(String(toLine).length, ' ');
        return `${lineNum}|${line}`;
      })
      .join('\n');

    return {
      ok: true,
      path: input.path,
      content: numbered,
      totalLines: result.totalLines,
      fromLine,
      toLine,
      rawContent: result.content,
    };
  } catch (e) {
    return {
      ok: false,
      path: input.path,
      content: '',
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
  replaceAll?: boolean;
  matchMode?: 'exact' | 'trimmed';
  allowExternal?: boolean;
}

export interface EditFileResult {
  ok: boolean;
  path: string;
  content?: string;
  fromLine?: number;
  toLine?: number;
  replacements?: number;
  /** replaceAll 时所有命中行的行号（1-based），用于多 hunk diff 展示 / All match line numbers for replaceAll, used for multi-hunk diff display */
  matchLines?: number[];
  error?: string;
}

export function editFile(input: EditFileInput): EditFileResult {
  try {
    const result = readTextContent(input.workspace, input.path, {
      allowExternal: input.allowExternal,
    });
    if (!result.ok) {
      return { ok: false, path: input.path, error: result.error };
    }

    const target = resolvePath(input.workspace, input.path, { allowExternal: input.allowExternal });
    const content = result.content;

    // old/new string 同步做换行正规化，与 readTextContent 对齐
    const normalizedOld = normalizeEOL(input.oldString);
    const normalizedNew = normalizeEOL(input.newString);

    if (input.matchMode === 'trimmed') {
      return editFileTrimmed(
        target,
        input.path,
        content,
        normalizedOld,
        normalizedNew,
        input.replaceAll,
      );
    }

    return tryExactMatch(
      target,
      input.path,
      content,
      normalizedOld,
      normalizedNew,
      input.replaceAll,
    );
  } catch (e) {
    return { ok: false, path: input.path, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 严格精确匹配（ADR-0026 §3）：包含空白；失败即报错并引导重读。
 *  模糊匹配降级为 matchMode='trimmed' 的内部显式 opt-in，不再无条件兜底——
 *  无条件降级会让 Receipt 无法表达"模型意图 vs 实际匹配"的差异。
 *  Strict exact matching: whitespace-sensitive; failures report an error that
 *  instructs the model to re-read. Fuzzy matching is an internal opt-in via
 *  matchMode='trimmed' only — unconditional fallbacks are removed. */
function tryExactMatch(
  target: string,
  path: string,
  content: string,
  oldStr: string,
  newStr: string,
  replaceAll?: boolean,
): EditFileResult {
  const index = content.indexOf(oldStr);
  if (index !== -1) {
    const secondIndex = content.indexOf(oldStr, index + 1);
    if (secondIndex !== -1 && !replaceAll) {
      return {
        ok: false,
        path,
        error: `old_string found ${content.split(oldStr).length - 1} times in ${path}. Use replaceAll: true or make old_string more specific. First match at offset ${index}.`,
      };
    }
    return performReplace(path, target, content, oldStr, newStr, replaceAll, index);
  }

  const snippet = oldStr.slice(0, 100).replace(/\n/g, '\\n');
  return {
    ok: false,
    path,
    error: `old_string not found in ${path}: "${snippet}..." Matching is exact (including whitespace). Re-read the file with read_file, then retry with the exact current content.`,
  };
}

function editFileTrimmed(
  target: string,
  path: string,
  content: string,
  oldString: string,
  newString: string,
  replaceAll?: boolean,
): EditFileResult {
  const oldLines = oldString.split('\n');
  const trimmedOldLines = oldLines.map((l) => l.trim());
  const contentLines = content.split('\n');
  const trimmedContentLines = contentLines.map((l) => l.trim());

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
    const snippet = oldString.slice(0, 100).replace(/\n/g, '\\n');
    return {
      ok: false,
      path,
      error: `old_string not found in ${path} (trimmed mode): "${snippet}..."`,
    };
  }

  let charOffset = 0;
  for (let k = 0; k < matchLine; k++) {
    charOffset += contentLines[k]!.length + 1;
  }

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
      return {
        ok: false,
        path,
        error: `old_string found ${matchCount} times in ${path} (trimmed mode). Use replaceAll: true or make old_string more specific.`,
      };
    }
  }

  return performReplaceTrimmed(
    path,
    target,
    content,
    contentLines,
    matchLine,
    oldLines.length,
    newString,
    replaceAll,
    charOffset,
    trimmedOldLines,
  );
}

function performReplaceTrimmed(
  path: string,
  target: string,
  _content: string,
  contentLines: string[],
  matchLine: number,
  oldLineCount: number,
  newStr: string,
  replaceAll: boolean | undefined,
  _charOffset: number,
  userTrimmedOldLines: string[],
): EditFileResult {
  let newContent: string;
  let matchLines: number[] | undefined;

  if (replaceAll) {
    const trimmedContentLines = contentLines.map((l) => l.trim());
    const trimmedOldLines = userTrimmedOldLines;
    const parts: string[] = [];
    matchLines = [];
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
        matchLines.push(i + 1); // 1-based
        parts.push(newStr);
        i += oldLineCount;
      } else {
        parts.push(contentLines[i]!);
        i++;
      }
    }
    for (; i < contentLines.length; i++) {
      parts.push(contentLines[i]!);
    }
    newContent = parts.join('\n');
  } else {
    const before = contentLines.slice(0, matchLine);
    const after = contentLines.slice(matchLine + oldLineCount);
    newContent = [...before, newStr, ...after].join('\n');
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, newContent, 'utf8');

  const fromLine = matchLine + 1;
  const newLines = newStr.split('\n').length;
  const toLine = fromLine + Math.max(0, newLines - 1);

  return {
    ok: true,
    path,
    content: newContent,
    fromLine,
    toLine,
    replacements: replaceAll ? undefined : 1,
    ...(matchLines && matchLines.length > 1 ? { matchLines } : {}),
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
  const matchLines: number[] = [];

  if (replaceAll) {
    // 收集所有命中行号 / Collect all match line numbers
    let pos = 0;
    const lineStarts: number[] = [0];
    for (let i = 0; i < content.length; i++) {
      if (content[i] === '\n') lineStarts.push(i + 1);
    }
    lineStarts.push(content.length + 1); // sentinel
    pos = content.indexOf(oldStr, pos);
    while (pos !== -1) {
      // 二分查找 pos 对应的行号 / Binary search to find line number for pos
      let lo = 0,
        hi = lineStarts.length - 2;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lineStarts[mid]! <= pos) lo = mid + 1;
        else hi = mid - 1;
      }
      matchLines.push(hi + 1); // 1-based
      pos += oldStr.length;
      pos = content.indexOf(oldStr, pos);
    }
    const parts = content.split(oldStr);
    replacements = parts.length - 1;
    newContent = parts.join(newStr);
  } else {
    newContent = content.slice(0, firstIndex) + newStr + content.slice(firstIndex + oldStr.length);
  }

  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, newContent, 'utf8');

  const before = content.slice(0, firstIndex).split('\n');
  const fromLine = before.length;
  const newLines = newStr.split('\n').length;
  const toLine = fromLine + Math.max(0, newLines - 1);

  return {
    ok: true,
    path,
    content: newContent,
    fromLine,
    toLine,
    replacements,
    ...(matchLines.length > 1 ? { matchLines } : {}),
  };
}

// ============================================================================
// write_file — 创建或覆写文件 / Create or overwrite file
// ============================================================================

export interface WriteFileInput {
  workspace: string;
  path: string;
  content: string;
  allowExternal?: boolean;
}

export interface WriteFileResult {
  ok: boolean;
  path: string;
  lines?: number;
  error?: string;
}

export function writeFile(input: WriteFileInput): WriteFileResult {
  try {
    mkdirSync(input.workspace, { recursive: true });
    const target = resolvePath(input.workspace, input.path, { allowExternal: input.allowExternal });
    mkdirSync(dirname(target), { recursive: true });

    writeFileSync(target, input.content, 'utf8');

    const lineCount = input.content.split('\n').length - (input.content.endsWith('\n') ? 1 : 0);

    return { ok: true, path: input.path, lines: lineCount };
  } catch (e) {
    return { ok: false, path: input.path, error: e instanceof Error ? e.message : String(e) };
  }
}
