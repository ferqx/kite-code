import React, { useState, useRef, useCallback } from "react";
import { Box, Text } from "ink";
import { useInput } from "ink";
import type { OutputLine } from "./types";
import MarkdownBlock from "./components/MarkdownBlock";
import { darkTheme as t } from "./theme";

interface OutputAreaProps {
  lines: OutputLine[];
  onToggleReason: (id: number) => void;
}

export default function OutputArea({ lines, onToggleReason }: OutputAreaProps) {
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const autoScrollRef = useRef(true);

  const scrollToBottom = useCallback(() => {
    autoScrollRef.current = true;
  }, []);

  const userScrolled = useCallback(() => {
    autoScrollRef.current = false;
  }, []);

  useInput((_input: unknown, key: { upArrow?: boolean; downArrow?: boolean; pageup?: boolean; pagedown?: boolean; end?: boolean; return?: boolean }) => {
    if (key.upArrow || key.pageup) {
      userScrolled();
      if (lines.length > 0) {
        setFocusedIndex((prev) => Math.max(0, (prev ?? lines.length) - 1));
      }
    }
    if (key.downArrow || key.pagedown) {
      if (lines.length > 0) {
        const next = Math.min(lines.length - 1, (prev ?? -1) + 1);
        setFocusedIndex(next);
        if (next === lines.length - 1) scrollToBottom();
      }
    }
    if (key.end) {
      setFocusedIndex(null);
      scrollToBottom();
    }
    if (key.return && focusedIndex !== null && focusedIndex < lines.length) {
      const line = lines[focusedIndex];
      if (line && line.type === "reason") {
        onToggleReason(line.id);
      }
    }
  });

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {lines.map((line, i) => (
        <Box key={line.id} flexDirection="column">
          {line.type === "reason" ? (
            <Box flexDirection="column">
              <Text color={i === focusedIndex ? t.primary : t.dim}>
                {line.folded ? "▶ Thinking..." : "▼ Thinking"}
              </Text>
              {!line.folded && (
                <Box paddingLeft={2}>
                  <Text color={t.muted}>{line.content}</Text>
                </Box>
              )}
            </Box>
          ) : (
            <Box>
              {i === focusedIndex ? (
                <Text color={t.primary}>❯ </Text>
              ) : null}
              <MarkdownBlock content={line.content} />
            </Box>
          )}
        </Box>
      ))}
    </Box>
  );
}
