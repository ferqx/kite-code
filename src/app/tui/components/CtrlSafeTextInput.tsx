// Patched version of ink-text-input v6 that filters ALL Ctrl+letter input,
// not just Ctrl+C. This prevents character leakage from TUI shortcuts like
// Ctrl+T, Ctrl+L, Ctrl+R, Ctrl+H, Ctrl+E, Ctrl+O, Ctrl+X.
import React, { useState, useEffect } from "react";
import { Text, useInput } from "ink";
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

  const cursorActualWidth = highlightPastedText ? cursorWidth : 0;
  const value = mask ? mask.repeat(originalValue.length) : originalValue;

  let renderedValue = value;
  let renderedPlaceholder = placeholder
    ? chalk.grey(placeholder)
    : undefined;

  if (showCursor && focus) {
    renderedPlaceholder =
      placeholder.length > 0
        ? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
        : chalk.inverse(" ");

    renderedValue = value.length > 0 ? "" : chalk.inverse(" ");
    let i = 0;
    for (const char of value) {
      renderedValue +=
        i >= cursorOffset - cursorActualWidth && i <= cursorOffset
          ? chalk.inverse(char)
          : char;
      i++;
    }

    if (value.length > 0 && cursorOffset === value.length) {
      renderedValue += chalk.inverse(" ");
    }
  }

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
        if (!key.shift && onSubmit) {
          onSubmit(originalValue);
        }
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

  return (
    <Text>
      {placeholder
        ? value.length > 0
          ? renderedValue
          : renderedPlaceholder
        : renderedValue}
    </Text>
  );
}

export default CtrlSafeTextInput;
