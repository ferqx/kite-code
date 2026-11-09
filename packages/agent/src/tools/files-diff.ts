import type { FileChangePreview, FileSnapshot } from './files';

/** Retained desktop line diff: common prefix/suffix, not an LCS or Git diff. */
export interface DiffLine {
  type: 'context' | 'removed' | 'added';
  lineNumber: number;
  text: string;
}

export interface DiffResult {
  lines: DiffLine[];
  addedLines: number;
  removedLines: number;
}

/**
 * 计算 oldStr → newStr 的统一 diff。
 * 算法：split 行 → 找公共前缀 → 找公共后缀 → 中间为变更区。
 * 适用于 edit_file 的单次连续替换模型。
 *
 * Compute a unified diff between oldStr and newStr.
 * Uses common-prefix / common-suffix detection (not full LCS),
 * suitable for edit_file's single-contiguous-replacement model.
 *
 * @param oldStr  被替换的文本（old_string）
 * @param newStr  替换后的文本（new_string）
 * @param startLine  变更起始行号（1-based，取 editFile 结果中的 fromLine）
 */
export function computeLineDiff(oldStr: string, newStr: string, startLine: number): DiffResult {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');

  // 找公共前缀 / Find common prefix
  let prefixLen = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (prefixLen < minLen && oldLines[prefixLen] === newLines[prefixLen]) {
    prefixLen++;
  }

  // 找公共后缀（在前缀之后）/ Find common suffix (after prefix)
  let suffixLen = 0;
  while (
    suffixLen < oldLines.length - prefixLen &&
    suffixLen < newLines.length - prefixLen &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const lines: DiffLine[] = [];

  // 上下文行：公共前缀 / Context lines: common prefix
  for (let i = 0; i < prefixLen; i++) {
    lines.push({
      type: 'context',
      lineNumber: startLine + i,
      text: oldLines[i]!,
    });
  }

  let currentLine = startLine + prefixLen;

  // 删除行：old 中不在公共前/后缀中的行
  // Removed lines: old lines not in common prefix/suffix
  const removedStart = prefixLen;
  const removedEnd = oldLines.length - suffixLen;
  for (let i = removedStart; i < removedEnd; i++) {
    lines.push({
      type: 'removed',
      lineNumber: currentLine,
      text: oldLines[i]!,
    });
    currentLine++;
  }

  // 新增行：new 中不在公共前/后缀中的行
  // Added lines: new lines not in common prefix/suffix
  const addedStart = prefixLen;
  const addedEnd = newLines.length - suffixLen;
  // 新增行的行号从 startLine + prefixLen 开始编排
  // (与删除行共享同一行号区间，表示"在此位置替换")
  let addLineNum = startLine + prefixLen;
  for (let i = addedStart; i < addedEnd; i++) {
    lines.push({
      type: 'added',
      lineNumber: addLineNum,
      text: newLines[i]!,
    });
    addLineNum++;
  }

  // 上下文行：公共后缀 / Context lines: common suffix
  for (let i = 0; i < suffixLen; i++) {
    lines.push({
      type: 'context',
      lineNumber: currentLine,
      text: oldLines[oldLines.length - suffixLen + i]!,
    });
    currentLine++;
  }

  const addedLines = addedEnd - addedStart;
  const removedLines = removedEnd - removedStart;

  return { lines, addedLines, removedLines };
}

// Preview generation never splits the whole file or builds an unbounded edit script.
// The line cursors retain offsets, not copies of potentially enormous source lines.
const PREVIEW_BYTES = 65536;
const PREVIEW_LINES = 400;
const LINE_UNITS = 2048;
const CONTEXT_LINES = 3;
const LOOKAHEAD_LINES = 16;

interface PreviewLine {
  start: number;
  end: number;
  next: number;
  number: number;
}

function lineAt(content: string, start: number, number: number): PreviewLine | undefined {
  if (start >= content.length) return undefined;
  const newline = content.indexOf('\n', start);
  const end = newline < 0 ? content.length : newline;
  return { start, end, next: newline < 0 ? end : end + 1, number };
}

function equalLine(a: string, x: PreviewLine, b: string, y: PreviewLine): boolean {
  // Include the terminator: changing only the final newline is still a real change.
  const length = x.next - x.start;
  if (length !== y.next - y.start) return false;
  for (let i = 0; i < length; i++) {
    if (a.charCodeAt(x.start + i) !== b.charCodeAt(y.start + i)) return false;
  }
  return true;
}

function following(content: string, first: PreviewLine | undefined): PreviewLine[] {
  const result: PreviewLine[] = [];
  let line = first;
  while (line && result.length < LOOKAHEAD_LINES) {
    result.push(line);
    line = lineAt(content, line.next, line.number + 1);
  }
  return result;
}

/** Bound only the stored presentation, never the file operation or Model result. */
export function fileChangePreview(
  before: FileSnapshot | null,
  after: FileSnapshot,
): FileChangePreview {
  const parts: string[] = [];
  let remaining = PREVIEW_BYTES;
  let rendered = 0;
  let truncated = false;
  let full = false;
  function append(value: string) {
    if (full) return;
    // Only bounded strings reach Buffer; leave space for a readable omission marker.
    const bytes = Buffer.from(value);
    if (bytes.length > remaining - 64 || rendered >= PREVIEW_LINES - 1) {
      parts.push('... preview truncated (64 KiB / 400 line limit) ...\n');
      full = true;
      truncated = true;
      return;
    }
    parts.push(value);
    remaining -= bytes.length;
    rendered++;
  }
  function emit(content: string, line: PreviewLine, prefix: string) {
    let end = Math.min(line.end, line.start + LINE_UNITS);
    if (end < line.end && /[\uD800-\uDBFF]/.test(content[end - 1]!)) end--;
    const clipped = end < line.end;
    if (clipped) truncated = true;
    append(
      `${String(line.number).padStart(2, ' ')} ${prefix}${content.slice(line.start, end)}${clipped ? ' … [line truncated at 2048 UTF-16 units]' : ''}\n`,
    );
    if (!full && line.next === line.end && prefix !== ' ') {
      append('\\ No newline at end of file\n');
    }
  }
  const unchanged = before?.content === after.content;
  const format = !before || unchanged ? 'file_content' : 'line_diff';
  if (format === 'file_content') {
    // Scan without allocating a line array. Empty content contains zero lines.
    let count = after.content.length > 0 ? 1 : 0;
    for (let i = 0; i < after.content.length - 1; i++) {
      if (after.content.charCodeAt(i) === 10) count++;
    }
    // Paths can also be untrusted and arbitrarily long.
    let path = after.path.slice(0, LINE_UNITS);
    if (/[\uD800-\uDBFF]$/.test(path)) path = path.slice(0, -1);
    if (path.length !== after.path.length) {
      truncated = true;
      path += ' … [path truncated]';
    }
    path = path.replaceAll('\r', '\\r').replaceAll('\n', '\\n');
    append(`Wrote ${count} lines to ${path}${unchanged ? ' (content unchanged)' : ''}\n`);
    let line = lineAt(after.content, 0, 1);
    while (line && !full) {
      emit(after.content, line, before ? ' ' : '+');
      line = lineAt(after.content, line.next, line.number + 1);
    }
  } else {
    const old = before!.content;
    const next = after.content;
    // Alignment uses a fixed lookahead, not an LCS. Do not report its replacements
    // as minimal added/removed totals, or imply omitted changes were counted.
    append('Line diff (bounded alignment; unchanged gaps omitted)\n');
    let left = lineAt(old, 0, 1);
    let right = lineAt(next, 0, 1);
    let pending: PreviewLine[] = [];
    let tail = 0;
    let omitted = false;
    while ((left || right) && !full) {
      if (left && right && equalLine(old, left, next, right)) {
        if (tail > 0) {
          emit(next, right, ' ');
          tail--;
        } else {
          pending.push(right);
          if (pending.length > CONTEXT_LINES) {
            pending.shift();
            omitted = true;
          }
        }
        left = lineAt(old, left.next, left.number + 1);
        right = lineAt(next, right.next, right.number + 1);
        continue;
      }
      if (omitted) append('... unchanged lines omitted ...\n');
      for (const line of pending) emit(next, line, ' ');
      pending = [];
      omitted = false;
      if (full) break;
      const oldWindow = following(old, left);
      const newWindow = following(next, right);
      let remove = left ? 1 : 0;
      let add = right ? 1 : 0;
      let distance = Number.POSITIVE_INFINITY;
      for (let i = 0; i < oldWindow.length; i++) {
        for (let j = 0; j < newWindow.length; j++) {
          const x = oldWindow[i]!;
          const y = newWindow[j]!;
          // Long lines are compared only at the current cursor, never repeatedly
          // as candidate anchors. This bounds lookahead work independently of size.
          if (
            i + j > 0 &&
            i + j < distance &&
            x.next - x.start <= LINE_UNITS &&
            equalLine(old, x, next, y)
          ) {
            remove = i;
            add = j;
            distance = i + j;
          }
        }
      }
      for (let i = 0; i < remove && left && !full; i++) {
        emit(old, left, '-');
        left = lineAt(old, left.next, left.number + 1);
      }
      for (let i = 0; i < add && right && !full; i++) {
        emit(next, right, '+');
        right = lineAt(next, right.next, right.number + 1);
      }
      tail = CONTEXT_LINES;
    }
  }
  return {
    version: 1,
    format,
    path: after.path,
    before: before?.baseline ?? null,
    after: after.baseline,
    text: parts.join(''),
    truncated,
  };
}
