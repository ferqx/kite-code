// Patched version of ink-text-input v6 that filters ALL Ctrl+letter input,
// not just Ctrl+C. This prevents character leakage from TUI shortcuts like
// Ctrl+T, Ctrl+L, Ctrl+R, Ctrl+H, Ctrl+E, Ctrl+O, Ctrl+X.
import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import chalk from "chalk";
import stringWidth from "string-width";

export interface AtomicBlock {
  start: number;
  end: number; // inclusive
}

interface WrappedLine {
  text: string;
  start: number; // character index in the original logical line
}

interface WrappedLines {
  lines: string[];
  breakpoints: number[]; // character index in the original value where each wrapped line starts
}

/**
 * Returns true for characters that belong to CJK (or related East Asian)
 * scripts. Break opportunities are allowed between these and non-CJK scripts,
 * which makes mixed-script text feel more natural when wrapping.
 */
function isCJK(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0x3040 && code <= 0x309f) || // Hiragana
    (code >= 0x30a0 && code <= 0x30ff) || // Katakana
    (code >= 0xac00 && code <= 0xd7af) || // Hangul Syllables
    (code >= 0x1100 && code <= 0x11ff) || // Hangul Jamo
    (code >= 0x3130 && code <= 0x318f) || // Hangul Compatibility Jamo
    (code >= 0xff00 && code <= 0xffef) || // Fullwidth forms
    (code >= 0x3000 && code <= 0x303f) // CJK punctuation
  );
}

function isASCIILetter(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function computeWidth(chars: string[], start: number, end: number): number {
  let width = 0;
  for (let k = start; k < end && k < chars.length; k++) {
    width += stringWidth(chars[k]);
  }
  return width;
}

/**
 * Soft-wrap a single logical line into visual lines that fit within `maxWidth`
 * display columns. Each CJK character is counted as 2 columns via string-width.
 *
 * Break priorities for a line that would overflow:
 *   1. Latest whitespace that keeps the line content within `maxWidth`.
 *      Whitespace itself is excluded from the line.
 *   2. Latest CJK/Non-CJK script boundary, but only when the remaining gap on
 *      the line is too small to fit the next script's first character. This
 *      prevents mixing scripts just to fill a tiny leftover space.
 *   3. Hard break at the last character that still fits. This fills the line
 *      as much as possible when no natural break point is available.
 */
function softWrapLine(text: string, maxWidth: number): WrappedLine[] {
  if (maxWidth <= 0 || text.length === 0) {
    return [{ text, start: 0 }];
  }

  // Split into Unicode code points and remember each code point's UTF-16 start
  // index so that wrapped-line start offsets match the original string.
  const chars: string[] = [];
  const indices: number[] = [];
  let pos = 0;
  for (const char of text) {
    chars.push(char);
    indices.push(pos);
    pos += char.length;
  }
  indices.push(pos);

  const result: WrappedLine[] = [];
  let lineStart = 0; // index in chars
  let lineStartIdx = 0; // UTF-16 index in text
  let lineWidth = 0;

  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    const charWidth = stringWidth(char);

    if (lineWidth + charWidth > maxWidth && i > lineStart) {
      let breakAt = -1;
      let excludeBreakChar = false;

      // 1. Latest whitespace whose preceding content fits.
      //    Whitespace is treated as a word boundary only when both sides are
      //    ASCII letters (a-zA-Z). In all other cases — digits, CJK, symbols —
      //    spaces are treated as normal characters and the line is filled
      //    before wrapping. This matches the expectation for mixed Chinese /
      //    digit / occasional-English terminal input.
      for (let j = i - 1; j >= lineStart; j--) {
        if (chars[j] === " " || chars[j] === "\t") {
          // Find the nearest non-whitespace characters on either side of this
          // space run to decide whether it is an English word boundary.
          let p = j - 1;
          while (p >= lineStart && (chars[p] === " " || chars[p] === "\t")) {
            p--;
          }
          let n = j + 1;
          while (n < chars.length && (chars[n] === " " || chars[n] === "\t")) {
            n++;
          }
          const prevChar = p >= lineStart ? chars[p] : undefined;
          const nextChar = n < chars.length ? chars[n] : undefined;
          const isWordBoundary =
            prevChar &&
            nextChar &&
            isASCIILetter(prevChar) &&
            isASCIILetter(nextChar);
          if (isWordBoundary) {
            const contentWidth = computeWidth(chars, lineStart, j);
            if (contentWidth <= maxWidth) {
              breakAt = j;
              excludeBreakChar = true;
              break;
            }
          }
        }
      }

      // 2. Latest script boundary that fits without wasting usable space.
      if (breakAt < 0) {
        for (let j = i - 1; j >= lineStart; j--) {
          if (
            j + 1 < chars.length &&
            isCJK(chars[j]) !== isCJK(chars[j + 1])
          ) {
            const widthUpToJ = computeWidth(chars, lineStart, j + 1);
            const nextCharWidth = stringWidth(chars[j + 1]);
            if (
              widthUpToJ <= maxWidth &&
              maxWidth - widthUpToJ < nextCharWidth
            ) {
              breakAt = j;
              excludeBreakChar = false;
              break;
            }
          }
        }
      }

      // 3. Hard break at the last character that still fits.
      if (breakAt < 0) {
        for (let j = i - 1; j >= lineStart; j--) {
          const widthUpToJ = computeWidth(chars, lineStart, j + 1);
          if (widthUpToJ <= maxWidth) {
            breakAt = j;
            excludeBreakChar = false;
            break;
          }
        }
      }

      // Fallback (should not happen): break before current char.
      if (breakAt < 0) {
        breakAt = i - 1;
        excludeBreakChar = false;
      }

      const lineEnd = breakAt + (excludeBreakChar ? 0 : 1);
      const lineText = chars.slice(lineStart, lineEnd).join("");
      result.push({ text: lineText, start: lineStartIdx });

      lineStart = breakAt + 1;
      lineStartIdx = indices[lineStart] ?? pos;
      lineWidth = 0;
      for (let k = lineStart; k <= i; k++) {
        lineWidth += stringWidth(chars[k]);
      }
    } else {
      lineWidth += charWidth;
    }
  }

  result.push({ text: chars.slice(lineStart).join(""), start: lineStartIdx });
  return result;
}

/**
 * Split the value into visual lines. Explicit `\n` boundaries are preserved,
 * and long logical lines are soft-wrapped to `maxWidth` columns when provided.
 */
function wrapDisplayLines(value: string, maxWidth?: number): WrappedLines {
  if (maxWidth === undefined) {
    const lines = value.length > 0 ? value.split("\n") : [""];
    const breakpoints = lines.map((_, i) => {
      let offset = 0;
      for (let j = 0; j < i; j++) {
        offset += lines[j].length + 1; // +1 for \n
      }
      return offset;
    });
    return { lines, breakpoints };
  }

  const logicalLines = value.length > 0 ? value.split("\n") : [""];
  const lines: string[] = [];
  const breakpoints: number[] = [];
  let offset = 0;

  for (let li = 0; li < logicalLines.length; li++) {
    const logicalLine = logicalLines[li];
    if (li > 0) {
      offset += 1; // account for the explicit newline
    }

    if (maxWidth <= 0 || logicalLine.length === 0) {
      lines.push(logicalLine);
      breakpoints.push(offset);
      offset += logicalLine.length;
      continue;
    }

    const wrapped = softWrapLine(logicalLine, maxWidth);
    for (const { text, start } of wrapped) {
      lines.push(text);
      breakpoints.push(offset + start);
    }
    offset += logicalLine.length;
  }

  return { lines, breakpoints };
}

/**
 * Find which visual line `cursorOffset` belongs to. When the offset is exactly
 * on a boundary between two visual lines, it is treated as the start of the
 * next line. This makes Right/End from the previous visual line land on the
 * next visual line, which matches the expectation for wrapped input.
 */
function findCursorLine(
  cursorOffset: number,
  breakpoints: number[],
  lineLengths: number[],
): number {
  for (let i = 0; i < breakpoints.length; i++) {
    const lineStart = breakpoints[i];
    const lineEnd = lineStart + lineLengths[i];
    if (cursorOffset >= lineStart && cursorOffset <= lineEnd) {
      // Boundary: offset is both the end of line i and the start of line i+1.
      if (
        cursorOffset === lineEnd &&
        i < breakpoints.length - 1 &&
        lineLengths[i] > 0
      ) {
        return i + 1;
      }
      return i;
    }
  }
  return 0;
}

interface Props {
  value: string;
  placeholder?: string;
  focus?: boolean;
  mask?: string;
  showCursor?: boolean;
  onChange: (value: string, meta?: { insertPos: number; insertLen: number }) => void;
  onSubmit?: (value: string) => void;
  atomicBlock?: AtomicBlock;
  onRemoveAtomicBlock?: () => void;
  /** 光标在首行按上/尾行按下时回调，用于历史导航 / Called when cursor at boundary for history navigation */
  onNavigateHistory?: (direction: "up" | "down") => void;
  /** 禁用上下箭头导航（如 slash 建议/文件搜索激活时） / Disable up/down arrow navigation (e.g. when slash suggestions or file search active) */
  disableArrowNav?: boolean;
  /** 紧跟在光标后的补全预览文字，光标将叠加在其首字符上 */
  trailingText?: string;
  /** 单行文本按终端宽度进行软换行的最大可用宽度（不含左侧前缀）。
   *  提供此值后，组件会主动按显示宽度折行，避免依赖 Ink Text 的自动
   *  wrap 在终端 resize 时出现行数震荡或字符断裂。 */
  maxWidth?: number;
}

function CtrlSafeTextInput({
  value: originalValue,
  placeholder = "",
  focus = true,
  mask,
  showCursor = true,
  onChange,
  onSubmit,
  atomicBlock,
  onRemoveAtomicBlock,
  onNavigateHistory,
  disableArrowNav,
  trailingText,
  maxWidth,
}: Props) {
  const [cursorOffset, setCursorOffset] = useState((originalValue || "").length);
  const cursorOffsetRef = useRef(cursorOffset);
  cursorOffsetRef.current = cursorOffset;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const showCursorRef = useRef(showCursor);
  showCursorRef.current = showCursor;
  const trailingTextRef = useRef(trailingText);
  trailingTextRef.current = trailingText;

  useEffect(() => {
    if (!focus || !showCursor) return;
    const newValue = originalValue || "";
    if (cursorOffsetRef.current > newValue.length - 1) {
      setCursorOffset(newValue.length);
    }
  }, [originalValue, focus, showCursor]);

  useEffect(() => {
    if (!atomicBlock) return;
    if (cursorOffsetRef.current > atomicBlock.start && cursorOffsetRef.current <= atomicBlock.end) {
      setCursorOffset(atomicBlock.end + 1);
    }
  }, [atomicBlock]);

  // Bracketed paste mode: receives the full pasted string in one callback.
  // Without this, pasted text arrives character-by-character through useInput
  // and the parent's paste placeholder threshold is never reached.
  usePaste((text) => {
    if (!text) return;
    const co = cursorOffsetRef.current;
    const newValue =
      originalValue.slice(0, co) +
      text +
      originalValue.slice(co);
    const newCursorOffset = co + text.length;
    setCursorOffset(newCursorOffset);
    onChange(newValue, { insertPos: co, insertLen: text.length });
  }, { isActive: focus });

  const value = mask ? mask.repeat(originalValue.length) : originalValue;

  // Keep one display column free for the cursor block whenever it is shown.
  // Without this, the inverse cursor at the end of a line can push the rendered
  // width past maxWidth, which makes Ink Text wrap swallow the prompt/ input
  // separator. Reserving the column for all cursor positions keeps the wrapped
  // layout stable as the cursor moves around.
  const cursorVisible = showCursor && focus && !trailingText;
  const reserveCursorColumn =
    maxWidth !== undefined && cursorVisible;
  const effectiveMaxWidth = reserveCursorColumn
    ? Math.max(1, maxWidth - 1)
    : maxWidth;

  // ── render helper: split into lines (soft-wrapped by terminal width), highlight cursor ──
  const { lines: displayLines, breakpoints } = wrapDisplayLines(value, effectiveMaxWidth);

  const cursorLine = findCursorLine(
    cursorOffset,
    breakpoints,
    displayLines.map((l) => l.length),
  );
  const cursorCol = cursorOffset - breakpoints[cursorLine];

  const renderedLines = (() => {
    if (!showCursor || !focus) {
      return displayLines.map((l) => l || " ");
    }
    return displayLines.map((line, lineIdx) => {
      if (lineIdx !== cursorLine) return line || " ";
      // Build line with cursor
      if (line.length === 0) return chalk.inverse(" ");
      let rendered = "";
      for (let j = 0; j < line.length; j++) {
        if (j === cursorCol) {
          rendered += chalk.inverse(line[j]);
        } else {
          rendered += line[j];
        }
      }
      if (cursorCol >= line.length) {
        if (trailingText) {
          rendered += chalk.inverse(trailingText[0]);
          if (trailingText.length > 1) {
            rendered += chalk.dim(trailingText.slice(1));
          }
        } else {
          rendered += chalk.inverse(" ");
        }
      } else if (trailingText) {
        rendered += chalk.dim(trailingText);
      }
      return rendered;
    });
  })();

  const renderedPlaceholder =
    placeholder
      ? showCursor && focus
        ? placeholder.length > 0
          ? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
          : chalk.inverse(" ")
        : chalk.grey(placeholder)
      : undefined;

  useInput(
    (rawInput, key) => {
      // Filter out CSI escape sequences (e.g., cursor position reports from terminal resize,
      // terminal focus reports [I / [O when ESC byte is stripped by Ink).
      if (/[\x1b\u001b]/.test(rawInput) || /\[\d+;\d+[A-Z]/.test(rawInput) || /^\[[IO]$/.test(rawInput)) {
        return;
      }

      // Only block the 3 global Ctrl shortcuts (C/T/E); all other Ctrl+let
      // no-op (don't insert the char, don't execute anything — safe default)
      if (
        (key.ctrl && /^[cCtTeE]$/.test(rawInput)) ||
        key.tab ||
        (key.shift && key.tab)
      ) {
        return;
      }
      if (key.ctrl) {
        // Any other Ctrl+key combo: no-op (don't insert character)
        return;
      }

      if (key.return && (key.shift || key.meta)) {
        // Insert newline at cursor position (cursor offset is known here but
        // not exposed to InputLine, so we handle Shift / Meta+Enter locally).
        const co = cursorOffsetRef.current;
        const newValue = originalValue.slice(0, co) + "\n" + originalValue.slice(co);
        setCursorOffset(co + 1);
        onChange(newValue);
        return;
      }

      if (key.return) {
        // Plain Enter handling is in InputLine to have reliable access to
        // handleSubmit and value without stale-closure risk.
        return;
      }

      // ── Up/Down: multi-line cursor movement or history navigation ──
      if ((key.upArrow || key.downArrow) && !disableArrowNav) {
        const co = cursorOffsetRef.current;
        const cursorVisibleForNav =
          showCursorRef.current &&
          focusRef.current &&
          !trailingTextRef.current;
        const reserveCursorColumnForNav =
          maxWidth !== undefined && cursorVisibleForNav;
        const effectiveMaxWidthForNav = reserveCursorColumnForNav
          ? Math.max(1, maxWidth - 1)
          : maxWidth;
        const { lines, breakpoints } = wrapDisplayLines(originalValue, effectiveMaxWidthForNav);
        const lineIdx = findCursorLine(
          co,
          breakpoints,
          lines.map((l) => l.length),
        );
        const col = co - breakpoints[lineIdx];

        if (key.upArrow) {
          if (lineIdx > 0) {
            const newCol = Math.min(col, lines[lineIdx - 1].length);
            const newOffset = breakpoints[lineIdx - 1] + newCol;
            setCursorOffset(newOffset);
          } else {
            onNavigateHistory?.("up");
          }
        } else {
          if (lineIdx < lines.length - 1) {
            const newCol = Math.min(col, lines[lineIdx + 1].length);
            const newOffset = breakpoints[lineIdx + 1] + newCol;
            setCursorOffset(newOffset);
          } else {
            onNavigateHistory?.("down");
          }
        }
        return;
      }

      // ── Home/End: move to start/end of current visual line ──
      if (
        (key.home || (key.ctrl && rawInput === "\x01") || key.end || (key.ctrl && rawInput === "\x05")) &&
        !disableArrowNav
      ) {
        const co = cursorOffsetRef.current;
        const cursorVisibleForNav =
          showCursorRef.current &&
          focusRef.current &&
          !trailingTextRef.current;
        const reserveCursorColumnForNav =
          maxWidth !== undefined && cursorVisibleForNav;
        const effectiveMaxWidthForNav = reserveCursorColumnForNav
          ? Math.max(1, maxWidth - 1)
          : maxWidth;
        const { lines, breakpoints } = wrapDisplayLines(
          originalValue,
          effectiveMaxWidthForNav,
        );
        const homeEndLineIdx = findCursorLine(
          co,
          breakpoints,
          lines.map((l) => l.length),
        );
        const lineStart = breakpoints[homeEndLineIdx];
        const lineEnd = lineStart + lines[homeEndLineIdx].length;
        if (key.home || (key.ctrl && rawInput === "\x01")) {
          setCursorOffset(lineStart);
        } else {
          setCursorOffset(lineEnd);
        }
        return;
      }

    // Some IMEs (e.g. macOS Chinese input) prepend a space when switching
    // between CJK composition and ASCII/digits. Strip that leading space when
    // it arrives as part of a single input event (space + character) and the
    // user had not just typed a space themselves.
    let input = rawInput;
    const co = cursorOffsetRef.current;
    if (
      input.length >= 2 &&
      input[0] === " " &&
      input[1] !== " " &&
      co > 0 &&
      originalValue[co - 1] !== " "
    ) {
      input = input.slice(1);
    }

    let nextCursorOffset = co;
    let nextValue = originalValue;
      let insertMeta: { insertPos: number; insertLen: number } | undefined;
      const ab = atomicBlock;

      if (ab) {
        if (key.leftArrow) {
          if (co > ab.start && co <= ab.end + 1) {
            nextCursorOffset = ab.start;
          } else {
            nextCursorOffset = co - 1;
          }
        } else if (key.rightArrow) {
          if (co >= ab.start && co < ab.end + 1) {
            nextCursorOffset = ab.end + 1;
          } else {
            nextCursorOffset = co + 1;
          }
        } else if (key.backspace) {
          if (co > ab.start && co <= ab.end + 1) {
            nextValue =
              originalValue.slice(0, ab.start) +
              originalValue.slice(ab.end + 1);
            nextCursorOffset = ab.start;
            setCursorOffset(nextCursorOffset);
            onChange(nextValue);
            onRemoveAtomicBlock?.();
            return;
          }
          if (co > 0) {
            nextValue =
              originalValue.slice(0, co - 1) +
              originalValue.slice(co);
            nextCursorOffset = co - 1;
          }
        } else if (key.delete) {
          if (co >= ab.start && co < ab.end + 1) {
            nextValue =
              originalValue.slice(0, ab.start) +
              originalValue.slice(ab.end + 1);
            nextCursorOffset = ab.start;
            setCursorOffset(nextCursorOffset);
            onChange(nextValue);
            onRemoveAtomicBlock?.();
            return;
          }
          if (co < originalValue.length) {
            nextValue =
              originalValue.slice(0, co) +
              originalValue.slice(co + 1);
          }
        } else {
          nextValue =
            originalValue.slice(0, co) +
            input +
            originalValue.slice(co);
          nextCursorOffset += input.length;
          insertMeta = { insertPos: co, insertLen: input.length };
        }
      } else {
        if (key.leftArrow) {
          if (showCursor) {
            nextCursorOffset = co - 1;
          }
        } else if (key.rightArrow) {
          if (showCursor) {
            nextCursorOffset = co + 1;
          }
        } else if (key.backspace || key.delete) {
          if (co > 0) {
            nextValue =
              originalValue.slice(0, co - 1) +
              originalValue.slice(co);
            nextCursorOffset = co - 1;
          }
        } else {
          nextValue =
            originalValue.slice(0, co) +
            input +
            originalValue.slice(co);
          nextCursorOffset = co + input.length;

          insertMeta = { insertPos: co, insertLen: input.length };
        }
      }

      if (nextCursorOffset < 0) {
        nextCursorOffset = 0;
      }

      if (nextCursorOffset > nextValue.length) {
        nextCursorOffset = nextValue.length;
      }

      setCursorOffset(nextCursorOffset);

      if (nextValue !== originalValue) {
        onChange(nextValue, insertMeta);
      }
    },
    { isActive: focus },
  );

  // ── multi-line or single-line? ──
  if (displayLines.length <= 1) {
    // Single line: keep original rendering (bare <Text>) for compat
    return (
      <Text>
        {placeholder && value.length === 0
          ? renderedPlaceholder
          : renderedLines[0]}
      </Text>
    );
  }

  // Multi-line: split across Box column
  return (
    <Box flexDirection="column">
      {placeholder && value.length === 0 ? (
        <Text>{renderedPlaceholder}</Text>
      ) : (
        renderedLines.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))
      )}
    </Box>
  );
}

export default CtrlSafeTextInput;
