// Patched version of ink-text-input v6 that filters ALL Ctrl+letter input,
// not just Ctrl+C. This prevents character leakage from TUI shortcuts like
// Ctrl+T, Ctrl+L, Ctrl+R, Ctrl+H, Ctrl+E, Ctrl+O, Ctrl+X.
import React, { useState, useEffect } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import chalk from "chalk";

export interface AtomicBlock {
  start: number;
  end: number; // inclusive
}

interface Props {
  value: string;
  placeholder?: string;
  focus?: boolean;
  mask?: string;
  highlightPastedText?: boolean;
  showCursor?: boolean;
  onChange: (value: string, meta?: { insertPos: number; insertLen: number }) => void;
  onSubmit?: (value: string) => void;
  atomicBlock?: AtomicBlock;
  onRemoveAtomicBlock?: () => void;
}

function CtrlSafeTextInput({
  value: originalValue,
  placeholder = "",
  focus = true,
  mask,
  highlightPastedText = false,
  showCursor = true,
  onChange,
  onSubmit,
  atomicBlock,
  onRemoveAtomicBlock,
}: Props) {
  const [state, setState] = useState({
    cursorOffset: (originalValue || "").length,
    cursorWidth: 0,
  });
  const { cursorOffset, cursorWidth } = state;

  useEffect(() => {
    setState((previousState) => {
      if (!focus || !showCursor) {
        return previousState;
      }
      const newValue = originalValue || "";
      if (previousState.cursorOffset > newValue.length - 1) {
        return {
          cursorOffset: newValue.length,
          cursorWidth: 0,
        };
      }
      return previousState;
    });
  }, [originalValue, focus, showCursor]);

  useEffect(() => {
    if (!atomicBlock) return;
    setState((prev) => {
      if (prev.cursorOffset > atomicBlock.start && prev.cursorOffset <= atomicBlock.end) {
        return { ...prev, cursorOffset: atomicBlock.end + 1 };
      }
      return prev;
    });
  }, [atomicBlock]);

  // Bracketed paste mode: receives the full pasted string in one callback.
  // Without this, pasted text arrives character-by-character through useInput
  // and the parent's paste placeholder threshold is never reached.
  usePaste((text) => {
    if (!text) return;
    const newValue =
      originalValue.slice(0, cursorOffset) +
      text +
      originalValue.slice(cursorOffset);
    const newCursorOffset = cursorOffset + text.length;
    setState({ cursorOffset: newCursorOffset, cursorWidth: text.length });
    onChange(newValue, { insertPos: cursorOffset, insertLen: text.length });
  }, { isActive: focus });

  const cursorActualWidth = highlightPastedText ? cursorWidth : 0;
  const value = mask ? mask.repeat(originalValue.length) : originalValue;

  // ── render helper: split into lines, highlight cursor ──
  const displayLines = value.length > 0 ? value.split("\n") : [""];

  let cursorLine = 0;
  let cursorCol = cursorOffset;
  for (let i = 0; i < displayLines.length; i++) {
    if (cursorCol <= displayLines[i].length) {
      cursorLine = i;
      break;
    }
    cursorCol -= displayLines[i].length + 1; // +1 for the \n
  }

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
        const highlighted =
          j >= cursorCol - cursorActualWidth && j <= cursorCol;
        rendered += highlighted ? chalk.inverse(line[j]) : line[j];
      }
      if (cursorCol >= line.length) {
        rendered += chalk.inverse(" ");
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
    (input, key) => {
      if (
        key.upArrow ||
        key.downArrow ||
        (key.ctrl && /^[a-zA-Z]$/.test(input)) ||
        key.tab ||
        (key.shift && key.tab)
      ) {
        return;
      }

      if (key.return) {
        // Enter / Shift+Enter handling is in InputLine to have reliable
        // access to handleSubmit and value without stale-closure risk.
        return;
      }

      let nextCursorOffset = cursorOffset;
      let nextValue = originalValue;
      let nextCursorWidth = 0;
      let insertMeta: { insertPos: number; insertLen: number } | undefined;
      const ab = atomicBlock;

      if (ab) {
        if (key.leftArrow) {
          if (cursorOffset > ab.start && cursorOffset <= ab.end + 1) {
            nextCursorOffset = ab.start;
          } else {
            nextCursorOffset = cursorOffset - 1;
          }
        } else if (key.rightArrow) {
          if (cursorOffset >= ab.start && cursorOffset < ab.end + 1) {
            nextCursorOffset = ab.end + 1;
          } else {
            nextCursorOffset = cursorOffset + 1;
          }
        } else if (key.backspace) {
          if (cursorOffset > ab.start && cursorOffset <= ab.end + 1) {
            nextValue =
              originalValue.slice(0, ab.start) +
              originalValue.slice(ab.end + 1);
            nextCursorOffset = ab.start;
            setState({ cursorOffset: nextCursorOffset, cursorWidth: 0 });
            onChange(nextValue);
            onRemoveAtomicBlock?.();
            return;
          }
          if (cursorOffset > 0) {
            nextValue =
              originalValue.slice(0, cursorOffset - 1) +
              originalValue.slice(cursorOffset);
            nextCursorOffset = cursorOffset - 1;
          }
        } else if (key.delete) {
          if (cursorOffset >= ab.start && cursorOffset < ab.end + 1) {
            nextValue =
              originalValue.slice(0, ab.start) +
              originalValue.slice(ab.end + 1);
            nextCursorOffset = ab.start;
            setState({ cursorOffset: nextCursorOffset, cursorWidth: 0 });
            onChange(nextValue);
            onRemoveAtomicBlock?.();
            return;
          }
          if (cursorOffset < originalValue.length) {
            nextValue =
              originalValue.slice(0, cursorOffset) +
              originalValue.slice(cursorOffset + 1);
          }
        } else {
          nextValue =
            originalValue.slice(0, cursorOffset) +
            input +
            originalValue.slice(cursorOffset);
          nextCursorOffset += input.length;
          if (input.length > 1) {
            nextCursorWidth = input.length;
          }
          insertMeta = { insertPos: cursorOffset, insertLen: input.length };
        }
      } else {
        if (key.leftArrow) {
          if (showCursor) {
            nextCursorOffset--;
          }
        } else if (key.rightArrow) {
          if (showCursor) {
            nextCursorOffset++;
          }
        } else if (key.backspace || key.delete) {
          if (cursorOffset > 0) {
            nextValue =
              originalValue.slice(0, cursorOffset - 1) +
              originalValue.slice(cursorOffset);
            nextCursorOffset--;
          }
        } else {
          nextValue =
            originalValue.slice(0, cursorOffset) +
            input +
            originalValue.slice(cursorOffset);
          nextCursorOffset += input.length;

          if (input.length > 1) {
            nextCursorWidth = input.length;
          }
          insertMeta = { insertPos: cursorOffset, insertLen: input.length };
        }
      }

      if (nextCursorOffset < 0) {
        nextCursorOffset = 0;
      }

      if (nextCursorOffset > nextValue.length) {
        nextCursorOffset = nextValue.length;
      }

      setState({
        cursorOffset: nextCursorOffset,
        cursorWidth: nextCursorWidth,
      });

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
