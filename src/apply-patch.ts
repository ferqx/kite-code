/**
 * apply_patch 工具：实现 Codex 风格的补丁解析和应用
 * apply_patch tool: Codex-style patch parsing and application
 *
 * 补丁格式 / Patch format:
 *   *** Begin Patch
 *   *** Add File: <path> [创建新文件 / create new file]
 *   +<line>
 *   *** Delete File: <path> [删除文件 / delete file]
 *   *** Update File: <path> [修改现有文件 / modify existing file]
 *   *** Move to: <new path> [可选重命名 / optional rename]
 *   @@ [header]      [上下文定位 / context anchoring]
 *   <space><line>    [上下文行 / context line]
 *   -<line>          [删除行 / delete line]
 *   +<line>          [添加行 / add line]
 *   *** End of File   [可选文件结束标记 / optional EOF marker]
 *   *** End Patch
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

// ============================================================================
// 类型定义 / Types
// ============================================================================

export interface ApplyPatchInput {
  workspace: string;
  patchContent: string;
}

export interface ApplyPatchResult {
  ok: boolean;
  path: string;
  message: string;
  /** 补丁操作后的受影响文件摘要 / Summary of affected files after patch */
  summary?: string;
}

/** 补丁操作类型 / Patch operation type */
type PatchOp =
  | { kind: "add"; file: string; lines: string[] }
  | { kind: "delete"; file: string }
  | { kind: "update"; file: string; moveTo?: string; chunks: PatchChunk[] };

/** 补丁中的变更块 / A hunk within a patch */
interface PatchChunk {
  /** @@ 后的上下文标识 / Context after @@ */
  header?: string;
  /** 上下文匹配行（空格前缀）/ Context match lines (space prefix) */
  contextBefore: string[];
  /** 要删除的行 / Lines to delete */
  oldLines: string[];
  /** 要添加的行 / Lines to add */
  newLines: string[];
  /** 上下文匹配行（空格前缀） / Context match lines (space prefix) */
  contextAfter: string[];
  /** 是否为文件末尾 / Is this the end of file */
  isEof: boolean;
}

// ============================================================================
// 补丁解析 / Patch Parser
// ============================================================================

class PatchParseError extends Error {
  constructor(message: string, public line?: number) {
    super(message);
    this.name = "PatchParseError";
  }
}

function resolvePath(workspace: string, file: string): string {
  const resolved = join(resolve(workspace), file);
  // 安全检查：确保路径在工作区内 / Safety: ensure path stays within workspace
  const rel = resolved.replace(resolve(workspace) + sep, "");
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new PatchParseError(`Refusing path outside workspace: ${file}`);
  }
  return resolved;
}

/** 解析补丁文本，返回操作列表和原始内容 / Parse patch text, return operations and raw content */
export function parsePatch(patchContent: string): PatchOp[] {
  const lines = patchContent.split("\n");
  let i = 0;

  // 跳过开头的空白 / Skip leading whitespace
  while (i < lines.length && lines[i].trim() === "") i++;

  // 匹配 *** Begin Patch / Match *** Begin Patch
  if (lines[i]?.trim() !== "*** Begin Patch") {
    throw new PatchParseError(
      `Expected "*** Begin Patch" but got: ${lines[i]?.trim() ?? "EOF"}`,
      i + 1,
    );
  }
  i++;

  const ops: PatchOp[] = [];

  while (i < lines.length) {
    const line = lines[i].trim();

    if (line === "*** End Patch" || line === "") {
      i++;
      continue;
    }

    // *** Add File: <path>
    const addMatch = line.match(/^\*\*\* Add File:\s+(.+)/i);
    if (addMatch) {
      const file = addMatch[1].trim();
      const contentLines: string[] = [];
      i++;
      while (i < lines.length && lines[i].startsWith("+")) {
        contentLines.push(lines[i].slice(1)); // 去掉 + 前缀 / Strip + prefix
        i++;
      }
      ops.push({ kind: "add", file, lines: contentLines });
      continue;
    }

    // *** Delete File: <path>
    const deleteMatch = line.match(/^\*\*\* Delete File:\s+(.+)/i);
    if (deleteMatch) {
      ops.push({ kind: "delete", file: deleteMatch[1].trim() });
      i++;
      continue;
    }

    // *** Update File: <path>
    const updateMatch = line.match(/^\*\*\* Update File:\s+(.+)/i);
    if (updateMatch) {
      const file = updateMatch[1].trim();
      let moveTo: string | undefined;
      i++;

      // 可选 *** Move to: <new path> / Optional *** Move to: <new path>
      if (i < lines.length) {
        const moveMatch = lines[i].trim().match(/^\*\*\* Move to:\s+(.+)/i);
        if (moveMatch) {
          moveTo = moveMatch[1].trim();
          i++;
        }
      }

      // 解析 hunks / Parse hunks
      const chunks: PatchChunk[] = parseHunks(lines, i);
      i = chunks.length > 0 ? (chunks as any)._endIndex ?? i + 1 : i + 1;
      ops.push({ kind: "update", file, moveTo, chunks });
      continue;
    }

    // 无法识别，跳过 / Unrecognized, skip
    i++;
  }

  return ops;
}

/** 解析 hunk 序列 / Parse hunk sequence */
function parseHunks(lines: string[], start: number): PatchChunk[] {
  const chunks: PatchChunk[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];

    // 下一个文件操作或结束 / Next file operation or end
    if (
      line.trim().startsWith("*** Add") ||
      line.trim().startsWith("*** Delete") ||
      line.trim().startsWith("*** Update") ||
      line.trim() === "*** End Patch"
    ) {
      break;
    }

    // 跳过空行 / Skip empty lines
    if (line.trim() === "") {
      i++;
      continue;
    }

    // @@ [header]
    if (line.trim().startsWith("@@")) {
      const headerMatch = line.match(/^@@\s*(.*)/);
      const header = headerMatch?.[1]?.trim() || undefined;
      i++;

      const contextBefore: string[] = [];
      const oldLines: string[] = [];
      const newLines: string[] = [];
      const contextAfter: string[] = [];
      let isEof = false;
      let inContextAfter = false;

      while (i < lines.length) {
        const hunkLine = lines[i];

        // *** End of File
        if (hunkLine.trim() === "*** End of File") {
          isEof = true;
          i++;
          break;
        }

        // 下一个 @@ 或结束 / Next @@ or end
        if (hunkLine.trim().startsWith("@@") ||
            hunkLine.trim().startsWith("*** Add") ||
            hunkLine.trim().startsWith("*** Delete") ||
            hunkLine.trim().startsWith("*** Update") ||
            hunkLine.trim() === "*** End Patch") {
          break;
        }

        if (hunkLine.startsWith(" ")) {
          // 上下文行 / Context line
          const ctxLine = hunkLine.slice(1);
          if (inContextAfter || oldLines.length > 0 || newLines.length > 0) {
            contextAfter.push(ctxLine);
            inContextAfter = true;
          } else {
            contextBefore.push(ctxLine);
          }
        } else if (hunkLine.startsWith("-")) {
          oldLines.push(hunkLine.slice(1));
          inContextAfter = false;
        } else if (hunkLine.startsWith("+")) {
          newLines.push(hunkLine.slice(1));
          inContextAfter = false;
        } else if (hunkLine.trim() === "") {
          // 空行可能导致提前结束？不，继续 / Empty line, continue
          if (oldLines.length > 0 || newLines.length > 0) {
            // 在变更后的空行视为 contextAfter / Empty line after change is contextAfter
            contextAfter.push("");
          }
          i++;
          continue;
        } else {
          // 无法识别的行，break / Unrecognized line, break
          break;
        }
        i++;
      }

      chunks.push({ header, contextBefore, oldLines, newLines, contextAfter, isEof });
      continue;
    }

    i++;
  }

  // 存储结束位置以便主解析器继续 / Store end position so main parser can continue
  (chunks as any)._endIndex = i;
  return chunks;
}

// ============================================================================
// 补丁应用 / Patch Application
// ============================================================================

interface AppliedResult {
  added: string[];
  modified: string[];
  deleted: string[];
}

/** 应用补丁到工作区 / Apply patch to workspace */
export function applyPatch(workspace: string, patchContent: string): ApplyPatchResult {
  try {
    const ops = parsePatch(patchContent);

    if (ops.length === 0) {
      return { ok: false, path: "", message: "No valid patch operations found." };
    }

    const result: AppliedResult = { added: [], modified: [], deleted: [] };

    for (const op of ops) {
      switch (op.kind) {
        case "add":
          applyAddFile(workspace, op.file, op.lines);
          result.added.push(op.file);
          break;
        case "delete":
          applyDeleteFile(workspace, op.file);
          result.deleted.push(op.file);
          break;
        case "update":
          applyUpdateFile(workspace, op.file, op.moveTo, op.chunks);
          if (op.moveTo) {
            result.deleted.push(op.file);
            result.added.push(op.moveTo);
          } else {
            result.modified.push(op.file);
          }
          break;
      }
    }

    const summary = buildSummary(result);
    return {
      ok: true,
      path: result.added[0] ?? result.modified[0] ?? result.deleted[0] ?? "",
      message: "Patch applied successfully.",
      summary,
    };
  } catch (e) {
    if (e instanceof PatchParseError) {
      return {
        ok: false,
        path: "",
        message: `Patch parse error${e.line ? ` at line ${e.line}` : ""}: ${e.message}`,
      };
    }
    if (e instanceof ApplyError) {
      return {
        ok: false,
        path: e.file,
        message: e.message,
      };
    }
    return {
      ok: false,
      path: "",
      message: `Unexpected error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ============================================================================
// 文件操作 / File Operations
// ============================================================================

class ApplyError extends Error {
  constructor(public file: string, message: string) {
    super(message);
    this.name = "ApplyError";
  }
}

function applyAddFile(workspace: string, file: string, lines: string[]): void {
  const target = resolvePath(workspace, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, lines.join("\n") + "\n", "utf8");
}

function applyDeleteFile(workspace: string, file: string): void {
  const target = resolvePath(workspace, file);
  if (!existsSync(target)) {
    throw new ApplyError(file, `Cannot delete: file "${file}" does not exist.`);
  }
  const { unlinkSync } = require("node:fs");
  unlinkSync(target);
}

function applyUpdateFile(
  workspace: string,
  file: string,
  moveTo: string | undefined,
  chunks: PatchChunk[],
): void {
  const target = resolvePath(workspace, file);

  if (!existsSync(target)) {
    throw new ApplyError(file, `Cannot update: file "${file}" does not exist.`);
  }

  const content = readFileSync(target, "utf8");
  const originalLines = content.split("\n");
  // 去掉末尾空行（split 产生的） / Remove trailing empty line from split
  if (originalLines.length > 0 && originalLines[originalLines.length - 1] === "") {
    originalLines.pop();
  }

  let lines = [...originalLines];

  // 按降序应用替换（防止索引偏移）/ Apply replacements in descending order (prevent index shifting)
  const replacements: Array<{
    index: number;
    deleteCount: number;
    newLines: string[];
  }> = [];

  let lineIndex = 0;
  for (const chunk of chunks) {
    // 定位：使用 @@ header 匹配 / Locate: use @@ header match
    if (chunk.header) {
      const found = findLineIndex(lines, chunk.header, lineIndex);
      if (found === -1) {
        throw new ApplyError(
          file,
          `Cannot find "@@ ${chunk.header}" in "${file}". The file may have changed or the context is incorrect.`,
        );
      }
      lineIndex = found + 1;
    }

    // 查找上下文 + oldLines 的位置 / Find context + oldLines position
    const searchStart = lineIndex;
    const foundIndex = findPatchLocation(lines, searchStart, chunk);

    // 纯添加（无 old lines）：插入到文件末尾 / Pure addition (no old lines): insert at end
    if (chunk.oldLines.length === 0 && chunk.newLines.length > 0) {
      let insertIdx = lines.length;
      // 如果最后一行是空行，插入前 / If last line is empty, insert before it
      if (lines.length > 0 && lines[lines.length - 1] === "") {
        insertIdx = lines.length - 1;
      }
      replacements.push({
        index: insertIdx,
        deleteCount: 0,
        newLines: chunk.newLines,
      });
      continue;
    }

    if (foundIndex === -1 && chunk.isEof && chunk.newLines.length > 0) {
      // EOF 添加 / EOF addition
      replacements.push({
        index: lines.length,
        deleteCount: 0,
        newLines: chunk.newLines,
      });
      continue;
    }

    if (foundIndex === -1) {
      // 尝试跳过 contextBefore，直接匹配 oldLines / Try skipping contextBefore, match oldLines directly
      const oldOnlyIndex = findLinesExact(lines, searchStart, chunk.oldLines);
      if (oldOnlyIndex !== -1) {
        replacements.push({
          index: oldOnlyIndex,
          deleteCount: chunk.oldLines.length,
          newLines: chunk.newLines,
        });
        lineIndex = oldOnlyIndex + chunk.oldLines.length;
        continue;
      }

      // 模糊匹配：标准化 Unicode 标点 / Fuzzy match: normalize Unicode punctuation
      const fuzzyIndex = findPatchLocationFuzzy(lines, searchStart, chunk);
      if (fuzzyIndex !== -1) {
        // 找到模糊匹配，将其视为精确匹配 / Found fuzzy match, treat as exact
        replacements.push({
          index: fuzzyIndex + chunk.contextBefore.length,
          deleteCount: chunk.oldLines.length,
          newLines: chunk.newLines,
        });
        lineIndex = fuzzyIndex + chunk.contextBefore.length + chunk.oldLines.length;
        continue;
      }

      // 展示已尝试匹配的上下文 / Show the context we tried to match
      const attempted = [
        ...chunk.contextBefore.map((l) => `  ${l}`),
        ...chunk.oldLines.map((l) => `- ${l}`),
      ].join("\n");
      throw new ApplyError(
        file,
        `Cannot find matching lines in "${file}"${chunk.header ? ` near "${chunk.header}"` : ""}. Tried to match:\n${attempted}\nFile content around line ${searchStart + 1}:\n${lines.slice(searchStart, searchStart + 5).map((l, idx) => `${searchStart + idx + 1}: ${l}`).join("\n")}`,
      );
    }

    replacements.push({
      index: foundIndex + chunk.contextBefore.length,
      deleteCount: chunk.oldLines.length,
      newLines: chunk.newLines,
    });

    lineIndex = foundIndex + chunk.contextBefore.length + chunk.oldLines.length + chunk.contextAfter.length;

    // 如果匹配到 contextAfter，需要调整替换范围 / If contextAfter matched, adjust replacement range
    if (chunk.contextAfter.length > 0) {
      // contextAfter 行已匹配，不需要删除 / contextAfter lines already matched, don't delete them
    }
  }

  // 降序排序并应用 / Sort descending and apply
  replacements.sort((a, b) => b.index - a.index);
  for (const rep of replacements) {
    lines.splice(rep.index, rep.deleteCount, ...rep.newLines);
  }

  const newContent = lines.join("\n") + "\n";

  if (moveTo) {
    const destTarget = resolvePath(workspace, moveTo);
    mkdirSync(dirname(destTarget), { recursive: true });
    writeFileSync(destTarget, newContent, "utf8");
    const { unlinkSync } = require("node:fs");
    unlinkSync(target);
  } else {
    writeFileSync(target, newContent, "utf8");
  }
}

// ============================================================================
// 匹配算法 / Matching Algorithms
// ============================================================================

/** 在 lines 中查找指定文本 / Find specified text in lines */
function findLineIndex(lines: string[], text: string, start: number): number {
  for (let i = start; i < lines.length; i++) {
    if (lines[i].includes(text)) return i;
  }
  return -1;
}

/** 查找补丁位置：上下文行 + 旧行的完整匹配 / Find patch location: full match of context lines + old lines */
function findPatchLocation(lines: string[], start: number, chunk: PatchChunk): number {
  const searchFor = [...chunk.contextBefore, ...chunk.oldLines];
  // 如果只添加新行无上下文（EOF 添加或纯添加），不需要查找 / If only adding lines without context (EOF or pure add), no search needed
  if (searchFor.length === 0) return -1;

  for (let i = start; i <= lines.length - searchFor.length; i++) {
    let match = true;
    for (let j = 0; j < searchFor.length; j++) {
      if (normalizeForMatch(lines[i + j]) !== normalizeForMatch(searchFor[j])) {
        match = false;
        break;
      }
    }
    if (match) {
      // 也验证 contextAfter（如果存在）/ Also verify contextAfter (if present)
      if (chunk.contextAfter.length > 0) {
        const afterStart = i + searchFor.length;
        let afterMatch = true;
        for (let j = 0; j < chunk.contextAfter.length && afterStart + j < lines.length; j++) {
          if (normalizeForMatch(lines[afterStart + j]) !== normalizeForMatch(chunk.contextAfter[j])) {
            afterMatch = false;
            break;
          }
        }
        if (!afterMatch) continue;
      }
      return i;
    }
  }

  return -1;
}

/** 精确行匹配 / Exact line match */
function findLinesExact(lines: string[], start: number, searchFor: string[]): number {
  if (searchFor.length === 0) return -1;
  for (let i = start; i <= lines.length - searchFor.length; i++) {
    let match = true;
    for (let j = 0; j < searchFor.length; j++) {
      if (lines[i + j] !== searchFor[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

/** 模糊匹配：标准化 Unicode 标点 / Fuzzy match: normalize Unicode punctuation */
function findPatchLocationFuzzy(lines: string[], start: number, chunk: PatchChunk): number {
  const searchFor = [...chunk.contextBefore, ...chunk.oldLines];
  if (searchFor.length === 0) return -1;

  for (let i = start; i <= lines.length - searchFor.length; i++) {
    let match = true;
    for (let j = 0; j < searchFor.length; j++) {
      if (!fuzzyEquals(lines[i + j], searchFor[j])) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

/** 行匹配标准化：统一空格、去除尾部空白 / Line match normalization: unify spaces, strip trailing whitespace */
function normalizeForMatch(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

/** 模糊相等：忽略 Unicode 标点差异 / Fuzzy equality: ignore Unicode punctuation differences */
function fuzzyEquals(a: string, b: string): boolean {
  const normalized = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/[\u2010-\u2015\u2018\u2019\u201c\u201d\u2013\u2014]/g, (c) => {
        // 映射常见 Unicode 标点到 ASCII / Map common Unicode punctuation to ASCII
        const map: Record<string, string> = {
          "\u2010": "-", // HYPHEN
          "\u2011": "-", // NON-BREAKING HYPHEN
          "\u2012": "-", // FIGURE DASH
          "\u2013": "-", // EN DASH
          "\u2014": "-", // EM DASH
          "\u2015": "-", // HORIZONTAL BAR
          "\u2018": "'", // LEFT SINGLE QUOTE
          "\u2019": "'", // RIGHT SINGLE QUOTE
          "\u201c": '"', // LEFT DOUBLE QUOTE
          "\u201d": '"', // RIGHT DOUBLE QUOTE
        };
        return map[c] ?? c;
      })
      .trim();

  return normalized(a) === normalized(b);
}

// ============================================================================
// 输出 / Output
// ============================================================================

/** 构建 git-style 摘要 / Build git-style summary */
function buildSummary(result: AppliedResult): string {
  const lines: string[] = ["Success. Updated the following files:"];
  for (const path of result.deleted) lines.push(`D ${path}`);
  for (const path of result.added) lines.push(`A ${path}`);
  for (const path of result.modified) lines.push(`M ${path}`);
  return lines.join("\n");
}

// ============================================================================
// 补丁格式说明（提供给模型的工具描述）/ Patch format description (for model tool description)
// ============================================================================

export const APPLY_PATCH_DESCRIPTION = `Use apply_patch to edit files using a structured patch format.

Patch format:
\`\`\`
*** Begin Patch
*** Add File: <path>
+line1
+line2
*** Update File: <path>
*** Move to: <new_path> [optional, for renaming]
@@ [optional header to locate code, e.g. class/function name]
 context_line
-old_line
+new_line
 context_line
*** Delete File: <path>
*** End Patch
\`\`\`

Rules:
- File paths must be relative (never absolute).
- "+" prefix: line to add (required even for new files).
- "-" prefix: line to delete.
- " " (space) prefix: context line (must match existing file exactly).
- "@@": optional anchor for locating code (class name, function name, etc.).
- "*** End of File": marks a hunk that adds content at end of file.
- Include 2-3 context lines around each change for reliable matching.
- Multiple file operations can be combined in one patch.
- All content must be exact — this is a deterministic tool, not AI-generated text.`;
