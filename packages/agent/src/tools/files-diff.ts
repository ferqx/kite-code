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

/** Bound only the stored presentation, never the file operation or Model result. */
export function fileChangePreview(
  before: FileSnapshot | null,
  after: FileSnapshot,
): FileChangePreview {
  const limit = 65536;
  const parts: string[] = [];
  let remaining = limit;
  let truncated = false;
  function append(value: string) {
    if (truncated) return;
    // At most remaining UTF-16 units can fit in the UTF-8 byte budget.
    let prefix = value.slice(0, remaining);
    if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
    const bytes = Buffer.from(prefix);
    let end = Math.min(remaining, bytes.length);
    while (end < bytes.length && end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
    const part = bytes.subarray(0, end).toString('utf8');
    parts.push(part);
    remaining -= end;
    truncated = part.length !== value.length;
  }
  const diff = before ? computeLineDiff(before.content, after.content, 1) : undefined;
  const unchanged = diff && diff.addedLines === 0 && diff.removedLines === 0;
  const format = !diff || unchanged ? 'file_content' : 'line_diff';
  if (format === 'file_content') {
    const lines = after.content.split('\n');
    const pad = Math.max(2, String(lines.length).length);
    append(
      `Wrote ${lines.length} lines to ${after.path}${unchanged ? ' (content unchanged)' : ''}\n`,
    );
    for (let index = 0; index < lines.length && !truncated; index++)
      append(`${String(index + 1).padStart(pad, ' ')}  ${lines[index]!}\n`);
  } else {
    append(`Added ${diff!.addedLines} lines, removed ${diff!.removedLines} lines\n`);
    const maxLine = diff!.lines.reduce((max, line) => Math.max(max, line.lineNumber), 0);
    const pad = Math.max(2, String(maxLine).length);
    for (const line of diff!.lines) {
      if (truncated) break;
      const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
      append(`${String(line.lineNumber).padStart(pad, ' ')} ${prefix}${line.text}\n`);
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
