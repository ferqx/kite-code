// ============================================================================
// computeLineDiff — 行级 diff 计算，用于 edit_file 结果展示
// Pure line-level diff for edit_file result display
// ============================================================================

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

/**
 * 将纯文本内容格式化为带行号的输出，首行为 header。
 * 用于 write_file 新建/追加场景（非 diff，仅展示写入内容）。
 *
 * Format plain text content with line numbers, first line as header.
 * Used for write_file create/append (not diff, just show written content).
 *
 * @param content  文件内容
 * @param header   首行摘要（如 "Wrote 4 lines to path"）
 */
export function formatContentOutput(content: string, header: string): string {
  const lines = content.split('\n');
  const pad = Math.max(2, String(lines.length).length);
  const numbered = lines.map((line, i) => {
    const num = String(i + 1).padStart(pad, ' ');
    return `${num}  ${line}`;
  });
  return `${header}\n${numbered.join('\n')}`;
}

/**
 * 将多 hunk diff（replaceAll）格式化为 stdout。
 * 相邻 hunk（间距 ≤ 3 行）合并展示，不连续 hunk 间插入 ...。
 *
 * Format multi-hunk diff (replaceAll) as stdout.
 * Adjacent hunks (gap ≤ 3 lines) are merged; non-contiguous hunks separated by ...
 *
 * @param oldStr  被替换的文本（old_string）
 * @param newStr  替换后的文本（new_string）
 * @param matchLines  每处命中的起始行号（1-based），长度即替换次数
 * @param replacements  替换次数，必须等于 matchLines.length
 */
export function formatMultiHunkDiff(
  oldStr: string,
  newStr: string,
  matchLines: number[],
  replacements: number,
): string {
  const parts: string[] = [];

  // 变更统计 — 累计增删行数（单次 × 替换次数）
  // Cumulative change stats (per-occurrence × replacements)
  const perOccurrence = computeLineDiff(oldStr, newStr, 1);
  const addedCount = perOccurrence.addedLines * replacements;
  const removedCount = perOccurrence.removedLines * replacements;
  const oldLinesCount = oldStr.split('\n').length;
  const addedLabel = addedCount === 1 ? '1 line' : `${addedCount} lines`;
  const removedLabel = removedCount === 1 ? '1 line' : `${removedCount} lines`;
  parts.push(
    `Added ${addedLabel}, removed ${removedLabel} (replaced ${replacements} time${replacements > 1 ? 's' : ''})`,
  );

  // 行号 padding — reduce 替代 Math.max(...) 避免超大数组栈溢出
  // Line number padding — reduce instead of Math.max(...) avoids stack overflow on huge match-lists
  const maxLineNum = matchLines.reduce((max, ml) => Math.max(max, ml), 0) + oldLinesCount;
  const pad = Math.max(2, String(maxLineNum).length);

  // 分组相邻 hunk（间距 ≤ 3 行则合并）/ Group adjacent hunks (gap ≤ 3 lines → merge)
  const hunkGroups: number[][] = [];
  for (const ml of matchLines) {
    const lastGroup = hunkGroups.at(-1);
    if (lastGroup && ml - (lastGroup.at(-1)! + oldLinesCount) <= 3) {
      lastGroup.push(ml);
    } else {
      hunkGroups.push([ml]);
    }
  }

  for (let g = 0; g < hunkGroups.length; g++) {
    const group = hunkGroups[g]!;
    // hunk 间插入省略号 / Insert ellipsis between hunk groups
    if (g > 0) parts.push('...');

    // 展示本组第一个变更 + 后续同组变更仅显示 +/- 行（无上下文重复）
    // Show first match's diff, subsequent same-group matches show only +/- lines
    for (let m = 0; m < group.length; m++) {
      const startLine = group[m]!;
      const diff = computeLineDiff(oldStr, newStr, startLine);

      if (m === 0) {
        // 第一个：完整 diff 含上下文 / First: full diff with context
        for (const line of diff.lines) {
          const num = String(line.lineNumber).padStart(pad, ' ');
          switch (line.type) {
            case 'context':
              parts.push(`${num}  ${line.text}`);
              break;
            case 'removed':
              parts.push(`${num} -${line.text}`);
              break;
            case 'added':
              parts.push(`${num} +${line.text}`);
              break;
          }
        }
      } else {
        // 同组后续：仅展示变更行 / Subsequent in group: only show changed lines
        for (const line of diff.lines) {
          if (line.type === 'context') continue;
          const num = String(line.lineNumber).padStart(pad, ' ');
          if (line.type === 'removed') parts.push(`${num} -${line.text}`);
          else parts.push(`${num} +${line.text}`);
        }
      }
    }
  }

  return parts.join('\n');
}

/**
 * 将 DiffResult 格式化为人类可读的 stdout 字符串。
 * 第 1 行为变更统计，后续行为行号 + 前缀 + 内容。
 *
 * Format DiffResult as a human-readable stdout string.
 * First line: change stats. Subsequent lines: line number + prefix + content.
 */
export function formatDiffOutput(diff: DiffResult): string {
  const parts: string[] = [];

  // 变更统计 / Change stats
  const addedLabel = diff.addedLines === 1 ? '1 line' : `${diff.addedLines} lines`;
  const removedLabel = diff.removedLines === 1 ? '1 line' : `${diff.removedLines} lines`;
  parts.push(`Added ${addedLabel}, removed ${removedLabel}`);

  // 行号 padding / Line number padding
  const maxLineNum = diff.lines.reduce((max, l) => Math.max(max, l.lineNumber), 0);
  const pad = Math.max(2, String(maxLineNum).length);

  for (const line of diff.lines) {
    const num = String(line.lineNumber).padStart(pad, ' ');
    switch (line.type) {
      case 'context':
        parts.push(`${num}  ${line.text}`);
        break;
      case 'removed':
        parts.push(`${num} -${line.text}`);
        break;
      case 'added':
        parts.push(`${num} +${line.text}`);
        break;
    }
  }

  return parts.join('\n');
}
