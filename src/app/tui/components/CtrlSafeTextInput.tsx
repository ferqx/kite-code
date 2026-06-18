// Patched version of ink-text-input v6 that filters ALL Ctrl+letter input,
// not just Ctrl+C. This prevents character leakage from TUI shortcuts like
// Ctrl+T, Ctrl+L, Ctrl+R, Ctrl+H, Ctrl+E, Ctrl+O, Ctrl+X.
import React, { useState, useEffect, useRef, useMemo } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import chalk from "chalk";
import { isCJK, isASCIILetter, softWrapLine, type WrappedLine } from "./soft-wrap";

const MAX_VISIBLE_LINES = 40;

export interface AtomicBlock {
  start: number;
  end: number; // inclusive
}

interface WrappedLines {
  lines: string[];
  breakpoints: number[]; // character index in the original value where each wrapped line starts
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
  const { lines: displayLines, breakpoints } = useMemo(
    () => wrapDisplayLines(value, effectiveMaxWidth),
    [value, effectiveMaxWidth],
  );

  const lineLengths = useMemo(
    () => displayLines.map((l) => l.length),
    [displayLines],
  );

  const cursorLine = findCursorLine(cursorOffset, breakpoints, lineLengths);
  const cursorCol = cursorOffset - breakpoints[cursorLine];

  const renderedLines = useMemo(() => {
    if (!showCursor || !focus) {
      return displayLines.map((l) => l || " ");
    }
    return displayLines.map((line, lineIdx) => {
      if (lineIdx !== cursorLine) return line || " ";
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
  }, [displayLines, showCursor, focus, cursorLine, cursorCol, trailingText]);

  const renderedPlaceholder = useMemo(
    () =>
      placeholder
        ? showCursor && focus
          ? placeholder.length > 0
            ? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
            : chalk.inverse(" ")
          : chalk.grey(placeholder)
        : undefined,
    [placeholder, showCursor, focus],
  );

  const needsVirtualized = displayLines.length > MAX_VISIBLE_LINES;

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

  // Multi-line: split across Box column.
  // When the input is very long, only render a sliding window around the cursor
  // to keep React element count and terminal I/O bounded.
  if (needsVirtualized) {
    const half = Math.floor(MAX_VISIBLE_LINES / 2);
    let viewStart = Math.max(0, cursorLine - half);
    let viewEnd = viewStart + MAX_VISIBLE_LINES;
    if (viewEnd > displayLines.length) {
      viewEnd = displayLines.length;
      viewStart = Math.max(0, viewEnd - MAX_VISIBLE_LINES);
    }

    const nodes: React.ReactNode[] = [];

    if (viewStart > 0) {
      nodes.push(
        <Text key="above" dimColor>
          ... {viewStart} more lines above ...
        </Text>,
      );
    }

    for (let i = viewStart; i < viewEnd; i++) {
      nodes.push(<Text key={i}>{renderedLines[i]}</Text>);
    }

    if (viewEnd < displayLines.length) {
      nodes.push(
        <Text key="below" dimColor>
          ... {displayLines.length - viewEnd} more lines below ...
        </Text>,
      );
    }

    return <Box flexDirection="column">{nodes}</Box>;
  }

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
